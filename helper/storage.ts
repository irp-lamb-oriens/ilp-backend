/**
 * helper/storage.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Private member-document storage (P1). Passports, deeds and family records
 * live in a private Cloud Storage bucket, never in Firestore and never behind
 * a public URL.
 *
 *   Bucket   env DOCUMENT_BUCKET (uniform bucket-level access, no public
 *            access; the service account in SERVICE_ACCOUNT_KEY needs
 *            roles/storage.objectAdmin on it).
 *   Objects  members/<clientId>/<docId>
 *   Types    pdf, jpg, png, heic, docx, checked against the file's own bytes
 *            (magic numbers), not the browser's claim.
 *   Size     15 MB max.
 *
 * Downloads: server-proxied, not signed URLs. Every download goes through an
 * authenticated route that re-checks ownership (member: own clientId; lawyer:
 * assigned to the member; staff: any) and writes an audit_log row
 * (`document.download`, target `clients/<clientId>`). Chosen over V4 signed
 * URLs because it needs no key-signing code, leaves no bearer link that can
 * be forwarded or logged, and audits each actual read. Files are small
 * (≤ 15 MB), so proxying through the API is cheap.
 *
 * Fallback: when DOCUMENT_BUCKET is unset and the server is not in production
 * (RENDER_EXTERNAL_URL unset), files are kept inline as base64 on the
 * `member_documents` doc (700 KB cap), as before. In production without a
 * bucket, uploads answer 503.
 *
 * Routes registered by documentAccessRouter(app) (from main.ts):
 *   GET /api/dashboard/members/:clientId/documents                staff list
 *   GET /api/dashboard/members/:clientId/documents/:docId/file    staff download
 *   GET /api/provider/members/:clientId/documents                 assigned lawyer list
 *   GET /api/provider/members/:clientId/documents/:docId/file     assigned lawyer download
 * The member's own routes stay in API/clientStatus/memberHome.ts.
 */

import express, { type Express, type Request, type Response } from "express";
import asyncHandler from "./asyncHandler.ts";
import auditLog from "./auditLog.ts";
import log from "./log.ts";
import get from "../db/get.ts";
import query from "../db/query.ts";
import { type AuthedRequest, requireDashboardAuth, requireProviderAuth } from "./auth/session.ts";
import { lawyerMaySee } from "../API/members/lawyerAccess.ts";
import type { Consultation, Matter } from "../schemas/contracts.ts";

export const DOCUMENTS_COLLECTION = "member_documents";
export const DOCUMENT_MAX_BYTES = 15 * 1024 * 1024;
/** Inline (dev-only) fallback: Firestore caps a document at 1 MiB; base64 adds a third. */
export const INLINE_MAX_BYTES = 700 * 1024;

export const DOCUMENT_TYPES = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;
export type DocumentContentType = typeof DOCUMENT_TYPES[keyof typeof DOCUMENT_TYPES];

const EXT_FOR: Record<string, string> = {
  [DOCUMENT_TYPES.pdf]: "pdf",
  [DOCUMENT_TYPES.jpg]: "jpg",
  [DOCUMENT_TYPES.png]: "png",
  [DOCUMENT_TYPES.heic]: "heic",
  [DOCUMENT_TYPES.docx]: "docx",
};

type Doc = Record<string, unknown>;

// ── Type checks ─────────────────────────────────────────────────────────────

function startsWith(b: Uint8Array, sig: number[], at = 0): boolean {
  if (b.length < at + sig.length) return false;
  return sig.every((v, i) => b[at + i] === v);
}

function ascii(b: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...b.subarray(from, Math.min(to, b.length)));
}

function containsAscii(b: Uint8Array, needle: string): boolean {
  const n = new TextEncoder().encode(needle);
  outer: for (let i = 0; i + n.length <= b.length; i++) {
    for (let j = 0; j < n.length; j++) if (b[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
}

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1", "heif"]);

/**
 * The allowlisted content type these bytes really are, or null. PDF, JPEG and
 * PNG by signature; HEIC/HEIF by its ISO-BMFF `ftyp` brand; DOCX as a ZIP that
 * contains `word/document.xml` (so other ZIPs, xlsx or executables are refused).
 */
export function sniffContentType(b: Uint8Array): DocumentContentType | null {
  if (startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return DOCUMENT_TYPES.pdf; // %PDF-
  if (startsWith(b, [0xff, 0xd8, 0xff])) return DOCUMENT_TYPES.jpg;
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return DOCUMENT_TYPES.png;
  if (ascii(b, 4, 8) === "ftyp" && HEIC_BRANDS.has(ascii(b, 8, 12))) return DOCUMENT_TYPES.heic;
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04]) && containsAscii(b, "word/document.xml")) return DOCUMENT_TYPES.docx;
  return null;
}

/** Ids that become object-name segments: no slashes, dots or spaces. */
export function safeId(id: unknown): string | null {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}

export function objectNameFor(clientId: string, docId: string): string {
  const c = safeId(clientId);
  const d = safeId(docId);
  if (!c || !d) throw new Error("Invalid document path.");
  return `members/${c}/${d}`;
}

export type StorageMode = "gcs" | "inline" | "unavailable";

export function storageMode(): StorageMode {
  if (Deno.env.get("DOCUMENT_BUCKET")) return "gcs";
  return Deno.env.get("RENDER_EXTERNAL_URL") ? "unavailable" : "inline";
}

/** Clean, header-safe file name that keeps the real extension. */
export function safeFileName(name: unknown, contentType: string): string {
  const base = String(name ?? "document")
    .replace(/[\r\n"\\/]/g, "")
    .replace(/[^\x20-\x7e]/g, "_")
    .trim()
    .slice(0, 120) || "document";
  const ext = EXT_FOR[contentType];
  return ext && !base.toLowerCase().endsWith(`.${ext}`) && !(ext === "jpg" && /\.jpe?g$/i.test(base))
    ? `${base.replace(/\.[A-Za-z0-9]{1,5}$/, "")}.${ext}`
    : base;
}

// ── Google Cloud Storage (JSON API) ─────────────────────────────────────────
// helper/getAccessToken.ts mints a datastore-scoped token only, so storage
// mints its own devstorage token from the same service account.

const STORAGE_SCOPE = "https://www.googleapis.com/auth/devstorage.read_write";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
let gcsToken: { value: string; exp: number } | null = null;

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function serviceAccount(): { client_email: string; private_key: string } {
  const raw = Deno.env.get("SERVICE_ACCOUNT_KEY");
  if (!raw) throw new Error("SERVICE_ACCOUNT_KEY is not set.");
  const expanded = raw.startsWith("~") ? raw.replace(/^~/, Deno.env.get("HOME") ?? "/root") : raw;
  return expanded.trim().startsWith("{") ? JSON.parse(expanded) : JSON.parse(Deno.readTextFileSync(expanded));
}

/** OAuth token for a scope, from the service account (JWT bearer flow). Cached ~1 h. */
export async function scopedAccessToken(scope = STORAGE_SCOPE): Promise<string> {
  if (scope === STORAGE_SCOPE && gcsToken && gcsToken.exp > Date.now() + 60_000) return gcsToken.value;
  const sa = serviceAccount();
  const pem = sa.private_key.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const input = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iss: sa.client_email, scope, aud: TOKEN_URL, iat: now, exp: now + 3600 })}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, new TextEncoder().encode(input)));
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${input}.${b64url(sig)}` }),
  });
  if (!res.ok) throw new Error(`Storage token request failed (${res.status})`);
  const data = (await res.json()) as { access_token: string; expires_in?: number };
  if (scope === STORAGE_SCOPE) gcsToken = { value: data.access_token, exp: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return data.access_token;
}

function bucket(): string {
  const b = Deno.env.get("DOCUMENT_BUCKET");
  if (!b) throw new Error("DOCUMENT_BUCKET is not set.");
  return b;
}

/** Upload bytes to the private bucket. Refuses to overwrite an existing object. */
export async function putObject(name: string, bytes: Uint8Array, contentType: string): Promise<void> {
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket())}/o` +
    `?uploadType=media&ifGenerationMatch=0&name=${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${await scopedAccessToken()}`, "Content-Type": contentType },
    body: bytes.slice(),
  });
  if (!res.ok) throw new Error(`Storage upload failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
}

/** Read an object's bytes from the private bucket. */
export async function getObject(name: string): Promise<Uint8Array> {
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket())}/o/${encodeURIComponent(name)}?alt=media`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await scopedAccessToken()}` } });
  if (!res.ok) throw new Error(`Storage download failed (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

// ── Member documents ────────────────────────────────────────────────────────

export type StoreResult =
  | { ok: true; fields: Doc; size: number; contentType: DocumentContentType }
  | { ok: false; status: number; error: string };

/**
 * Validate and store one member document. Returns the fields to merge into
 * the `member_documents` metadata doc (storage location, sniffed type, size;
 * `dataBase64` only in the inline dev fallback).
 */
export async function storeMemberDocument(clientId: string, docId: string, bytes: Uint8Array): Promise<StoreResult> {
  if (!bytes.length) return { ok: false, status: 400, error: "Choose a file to upload." };
  if (bytes.length > DOCUMENT_MAX_BYTES) {
    return { ok: false, status: 413, error: "That file is larger than 15 MB. Try a smaller scan, or email it to your ILP team." };
  }
  const contentType = sniffContentType(bytes);
  if (!contentType) {
    return { ok: false, status: 415, error: "That file type is not accepted. Upload a PDF, JPG, PNG, HEIC or Word (.docx) file." };
  }
  const mode = storageMode();
  if (mode === "unavailable") {
    log("[storage] DOCUMENT_BUCKET is not set in production: upload refused", "error");
    return { ok: false, status: 503, error: "Document upload is temporarily unavailable. Please email the file to your ILP team." };
  }
  if (mode === "inline") {
    if (bytes.length > INLINE_MAX_BYTES) {
      return { ok: false, status: 413, error: "Local storage is limited to 700 KB per file (set DOCUMENT_BUCKET for 15 MB)." };
    }
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { ok: true, size: bytes.length, contentType, fields: { storage: "inline", dataBase64: btoa(bin) } };
  }
  const objectName = objectNameFor(clientId, docId);
  await putObject(objectName, bytes, contentType);
  return { ok: true, size: bytes.length, contentType, fields: { storage: "gcs", objectName } };
}

/** The bytes of a stored document (GCS or the inline fallback), or null. */
export async function readMemberDocument(d: Doc): Promise<Uint8Array | null> {
  if (d.storage === "gcs" && typeof d.objectName === "string") return await getObject(d.objectName);
  if (typeof d.dataBase64 === "string") return Uint8Array.from(atob(d.dataBase64), (c) => c.charCodeAt(0));
  return null;
}

/** Metadata safe to return to any reader: no bytes, no bucket path. */
export function documentMeta(d: Doc): Doc {
  const { dataBase64: _b, objectName: _o, ...rest } = d;
  return rest;
}

/** Send a document as an attachment with headers that stop inline rendering and caching. */
export function sendDocument(res: Response, d: Doc, bytes: Uint8Array): void {
  const type = String(d.contentType ?? "application/octet-stream");
  const name = safeFileName(d.fileName, type);
  res.setHeader("Content-Type", type);
  res.setHeader("Content-Disposition", `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader("Content-Length", String(bytes.length));
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.send(bytes);
}

/** audit_log row for every document read. Awaited, but never fails the download. */
export async function auditDocumentDownload(
  actor: { email: string; role: string },
  d: Doc,
  via: "member" | "staff" | "lawyer",
): Promise<void> {
  try {
    await auditLog({
      actor: { uid: actor.email, email: actor.email, role: actor.role },
      action: "document.download",
      target: `clients/${String(d.clientId)}`,
      meta: { docId: d.id, category: d.category, via },
    });
  } catch (err) {
    log(`[storage] audit write failed for document ${String(d.id)}: ${err instanceof Error ? err.message : err}`, "error");
  }
}

/**
 * Body parser for the member upload route: the raw file bytes (any content
 * type, 15 MB + headroom). JSON bodies already parsed upstream pass through.
 */
export const rawDocumentBody = express.raw({ type: () => true, limit: DOCUMENT_MAX_BYTES + 64 * 1024 });

/** Request body as bytes: a raw upload (Buffer) or the legacy JSON `dataBase64`. */
export function uploadBytes(body: unknown): Uint8Array | null {
  if (body instanceof Uint8Array) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  const b64 = (body as Doc | null)?.dataBase64;
  if (typeof b64 === "string" && b64) {
    try {
      return Uint8Array.from(atob(b64.replace(/^data:[^,]*,/, "")), (c) => c.charCodeAt(0));
    } catch {
      return null;
    }
  }
  return null;
}

// ── Staff and lawyer access ─────────────────────────────────────────────────

async function listDocs(clientId: string): Promise<Doc[]> {
  const rows = (await query(DOCUMENTS_COLLECTION, [{ field: "clientId", op: "EQUAL", value: clientId }])) as Doc[];
  return rows
    .map(documentMeta)
    .sort((a, b) => String(b.uploadedAt ?? "").localeCompare(String(a.uploadedAt ?? "")));
}

/** Same rule as the lawyer brief: assigned on the client, on a matter, or on a consultation. */
export async function lawyerAssignedTo(providerId: string, clientId: string): Promise<boolean> {
  if (!providerId) return false;
  const client = (await get("clients", clientId)) as Doc | null;
  if (!client) return false;
  if (client.assignedProviderId === providerId) return true;
  const [matters, consultations] = await Promise.all([
    query("matters", [{ field: "clientId", op: "EQUAL", value: clientId }]),
    query("consultations", [{ field: "clientId", op: "EQUAL", value: clientId }]),
  ]);
  // REL: the shared rule (API/members/lawyerAccess.ts): open matters, live calls, a handoff still owed.
  return lawyerMaySee(providerId, client, matters as unknown as Matter[], consultations as unknown as Consultation[]);
}

async function serveFile(req: Request, res: Response, actor: { email: string; role: string }, via: "staff" | "lawyer") {
  const clientId = safeId(req.params.clientId);
  const docId = safeId(req.params.docId);
  if (!clientId || !docId) return res.status(404).json({ error: "Not found." });
  const d = (await get(DOCUMENTS_COLLECTION, docId)) as Doc | null;
  if (!d || d.clientId !== clientId) return res.status(404).json({ error: "Not found." });
  const bytes = await readMemberDocument({ ...d, id: docId });
  if (!bytes) return res.status(404).json({ error: "Not found." });
  await auditDocumentDownload(actor, { ...d, id: docId }, via);
  sendDocument(res, d, bytes);
}

export function documentAccessRouter(app: Express): void {
  const staffActor = (req: Request) => ({
    email: String((req as AuthedRequest).dashboardUser ?? "unknown"),
    role: (req as AuthedRequest).dashboardRole ?? "staff",
  });
  const lawyerOk = async (req: Request, res: Response): Promise<boolean> => {
    const clientId = safeId(req.params.clientId);
    const pid = String((req as AuthedRequest).providerId ?? "");
    if (!clientId || !(await lawyerAssignedTo(pid, clientId))) {
      res.status(404).json({ error: "Member not found." });
      return false;
    }
    return true;
  };

  app.get(
    "/api/dashboard/members/:clientId/documents",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const clientId = safeId(req.params.clientId);
      if (!clientId) return res.status(404).json({ error: "Not found." });
      res.json({ items: await listDocs(clientId) });
    }),
  );

  app.get(
    "/api/dashboard/members/:clientId/documents/:docId/file",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      await serveFile(req, res, staffActor(req), "staff");
    }),
  );

  app.get(
    "/api/provider/members/:clientId/documents",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      if (!(await lawyerOk(req, res))) return;
      res.json({ items: await listDocs(String(req.params.clientId)) });
    }),
  );

  app.get(
    "/api/provider/members/:clientId/documents/:docId/file",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      if (!(await lawyerOk(req, res))) return;
      const email = String((req as AuthedRequest).providerUser ?? "unknown");
      await serveFile(req, res, { email, role: "lawyer" }, "lawyer");
    }),
  );
}
