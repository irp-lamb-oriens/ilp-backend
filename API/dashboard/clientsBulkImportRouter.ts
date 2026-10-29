/**
 * API/dashboard/clientsBulkImportRouter.ts — bulk JSON import for CRM clients.
 *
 * Two endpoints:
 *   POST /api/dashboard/import/clients/dry-run   (validate + annotate, no write)
 *   POST /api/dashboard/import/clients/commit    (write into `clients`)
 *
 * Ported from IRP-funnel, retargeted to ILP:
 *   • Target collection is `clients` (flat doc, id === email-normalized id).
 *   • Create writes use `put` at a fixed doc id (ILP's `post` auto-generates ids).
 *   • Field registry is advisory only; unknown/extra fields are always kept.
 */

import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import log from "../../helper/log.ts";
import get from "../../db/get.ts";
import put from "../../db/put.ts";
import { requireDashboardAuth } from "../../helper/auth/session.ts";
import { emailToDocId } from "../../helper/auth/otp.ts";
import { ensureFieldConfig, getExpectedImportFields } from "./automation/fieldConfig.ts";
import type { FieldDef } from "./automation/fieldDefaults.ts";
import { campaignSlug, createOutreach } from "../journeys/outreach.ts"; // JOURNEYS

const CLIENTS_COLLECTION = "clients";
const MAX_RECORDS = 500;

type ImportStrategy = "skip" | "merge" | "overwrite";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function recordEmail(record: unknown): string {
  if (!isPlainObject(record)) return "";
  const direct =
    (typeof record.dripEmail === "string" && record.dripEmail) ||
    (typeof record.email === "string" && record.email) ||
    "";
  if (direct.includes("@")) return direct.trim();
  const cons = Array.isArray((record as Record<string, unknown>).consultations)
    ? ((record as Record<string, unknown>).consultations as unknown as Record<string, unknown>[])
    : [];
  const latest = cons.length > 0 ? cons[cons.length - 1] : null;
  const nested = latest && typeof latest.email === "string" ? latest.email : "";
  return nested.includes("@") ? nested.trim() : "";
}

export function deriveDocId(record: unknown): {
  docId: string | null;
  email: string;
  docIdMismatch?: string;
} {
  const email = recordEmail(record);
  const explicit =
    isPlainObject(record) && typeof (record as Record<string, unknown>).docId === "string" &&
      String((record as Record<string, unknown>).docId).trim()
      ? String((record as Record<string, unknown>).docId).trim()
      : "";

  if (email) {
    const canonical = emailToDocId(email);
    return {
      docId: canonical,
      email,
      docIdMismatch: explicit && explicit !== canonical ? explicit : undefined,
    };
  }
  if (explicit) return { docId: explicit, email: "" };
  return { docId: null, email: "" };
}

function readField(record: unknown, field: FieldDef): unknown {
  if (!isPlainObject(record)) return undefined;
  if (field.scope === "root") return (record as Record<string, unknown>)[field.id];
  const cons = Array.isArray((record as Record<string, unknown>).consultations)
    ? ((record as Record<string, unknown>).consultations as unknown as Record<string, unknown>[])
    : [];
  const latest = cons.length > 0 ? cons[cons.length - 1] : null;
  if (latest && latest[field.id] !== undefined) return latest[field.id];
  return (record as Record<string, unknown>)[field.id];
}

function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}

function typeWarning(value: unknown, field: FieldDef): string | null {
  if (isEmptyValue(value)) return null;
  switch (field.valueType) {
    case "string":
    case "text":
    case "email":
      if (typeof value !== "string") return `${field.label}: expected text`;
      if (field.valueType === "email" && !String(value).includes("@"))
        return `${field.label}: not a valid email`;
      return null;
    case "number":
      if (typeof value === "number") return null;
      if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value)))
        return null;
      return `${field.label}: expected a number`;
    case "boolean":
      return typeof value === "boolean" ? null : `${field.label}: expected true/false`;
    case "date":
    case "datetime":
      return Number.isNaN(new Date(value as string).getTime())
        ? `${field.label}: unrecognized date`
        : null;
    case "enum": {
      const opts = Array.isArray(field.options) ? field.options : [];
      if (opts.length === 0) return null;
      return opts.includes(String(value)) ? null : `${field.label}: "${value}" not in allowed choices`;
    }
    default:
      return null;
  }
}

function unionNotes(existing: unknown, incoming: unknown): unknown[] {
  const ex = Array.isArray(existing) ? existing : [];
  const inc = Array.isArray(incoming) ? incoming : [];
  const seen = new Set(ex.map((n) => (n as Record<string, unknown>)?.createdAt));
  const extra = inc.filter((n) => n && !seen.has((n as Record<string, unknown>).createdAt));
  return [...ex, ...extra];
}

function shallowMerge(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(incoming)) {
    const e = existing?.[k];
    const i = incoming[k];
    out[k] = isPlainObject(e) && isPlainObject(i) ? { ...e, ...i } : i;
  }
  return out;
}

function extractRecords(body: unknown): unknown[] {
  const b = isPlainObject(body) ? body : {};
  if (Array.isArray(b.records)) return b.records;
  if (Array.isArray(b.clients)) return b.clients;
  if (Array.isArray(body)) return body;
  return [];
}

export default function clientsBulkImportRouter(app: Express): void {
  app.post(
    "/api/dashboard/import/clients/dry-run",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const records = extractRecords(req.body);
      if (records.length === 0) {
        return res.status(400).json({ error: "No records to import. Expected a JSON array or { clients: [...] }." });
      }
      if (records.length > MAX_RECORDS) {
        return res.status(413).json({
          error: `Too many records (${records.length}). Split into batches of ${MAX_RECORDS} or fewer.`,
        });
      }

      await ensureFieldConfig();
      const expected = getExpectedImportFields();
      const requiredFields = expected.filter((f) => f.required);

      let newCount = 0;
      let duplicateCount = 0;
      let invalid = 0;
      const annotated: unknown[] = [];

      for (let index = 0; index < records.length; index++) {
        const record = records[index];
        const { docId, email, docIdMismatch } = deriveDocId(record);

        if (!docId) {
          invalid++;
          annotated.push({
            index, docId: null, email: "", valid: false, exists: false,
            missingRequired: [],
            warnings: ["No docId and no valid email — cannot determine a target record."],
          });
          continue;
        }

        const existing = await get(CLIENTS_COLLECTION, docId).catch(() => null);
        const exists = !!existing;
        if (exists) duplicateCount++;
        else newCount++;

        const missingRequired: string[] = [];
        for (const f of requiredFields) {
          if (isEmptyValue(readField(record, f))) missingRequired.push(f.label);
        }
        const warnings: string[] = [];
        for (const f of expected) {
          const w = typeWarning(readField(record, f), f);
          if (w) warnings.push(w);
        }
        if (docIdMismatch) {
          warnings.push(`File's docId ("${docIdMismatch}") ignored — matched by email to "${docId}" instead.`);
        }

        annotated.push({ index, docId, email, valid: true, exists, missingRequired, warnings });
      }

      res.json({
        total: records.length,
        valid: records.length - invalid,
        invalid,
        newCount,
        duplicateCount,
        records: annotated,
        expectedFields: expected.map((f) => ({
          id: f.id,
          label: f.label,
          valueType: f.valueType,
          required: !!f.required,
          scope: f.scope,
        })),
      });
    }),
  );

  app.post(
    "/api/dashboard/import/clients/commit",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const actor: string = (req as Request & { dashboardUser?: string }).dashboardUser ?? "dashboard";
      const records = extractRecords(req.body);
      const defaultStrategy: ImportStrategy =
        req.body?.defaultStrategy === "merge" || req.body?.defaultStrategy === "overwrite"
          ? req.body.defaultStrategy
          : "skip";
      const strategies: Record<string, ImportStrategy> =
        isPlainObject(req.body?.strategies) ? req.body.strategies : {};

      if (records.length === 0) {
        return res.status(400).json({ error: "No records to import." });
      }
      if (records.length > MAX_RECORDS) {
        return res.status(413).json({
          error: `Too many records (${records.length}). Split into batches of ${MAX_RECORDS} or fewer.`,
        });
      }

      // JOURNEYS: imported people are outbound leads; created rows get an Outreach (channel import).
      const campaign = campaignSlug(req.body?.campaign) ?? `import-${new Date().toISOString().slice(0, 10)}`;
      let created = 0;
      let updated = 0;
      let skipped = 0;
      const errors: Array<{ index: number; docId?: string; error: string }> = [];

      for (let index = 0; index < records.length; index++) {
        const record = records[index];
        const { docId, email, docIdMismatch } = deriveDocId(record);
        if (!docId) {
          errors.push({ index, error: "No docId or valid email." });
          continue;
        }

        try {
          const existing = await get(CLIENTS_COLLECTION, docId).catch(() => null);
          const strategy: ImportStrategy = strategies[docId] || defaultStrategy;
          const nowIso = new Date().toISOString();

          const incoming: Record<string, unknown> = isPlainObject(record) ? { ...record } : {};
          delete incoming.docId;

          const importEntry: Record<string, unknown> = {
            type: "bulk_import",
            actor,
            action: existing ? strategy : "created",
            source: "json_import",
            timestamp: nowIso,
          };
          if (docIdMismatch) importEntry.ignoredFileDocId = docIdMismatch;

          if (!existing) {
            const toCreate: Record<string, unknown> = { ...incoming };
            if (!toCreate.dripEmail && email) toCreate.dripEmail = email;
            toCreate.activityLog = [
              ...(Array.isArray(incoming.activityLog) ? incoming.activityLog : []),
              importEntry,
            ];
            if (incoming.notes !== undefined) {
              toCreate.notes = Array.isArray(incoming.notes) ? incoming.notes : [];
            }
            await put(CLIENTS_COLLECTION, docId, toCreate);
            created++;
            await createOutreach({ channel: "import", campaign, sentBy: actor, clientId: docId, ...(email ? { email } : {}) })
              .catch((err) => log(`[bulk-import] outreach for ${docId} failed: ${err instanceof Error ? err.message : err}`));
          } else if (strategy === "skip") {
            skipped++;
          } else {
            const payload: Record<string, unknown> =
              strategy === "merge" ? shallowMerge(existing, incoming) : { ...incoming };
            delete payload.docId;
            payload.activityLog = [
              ...(Array.isArray(existing.activityLog) ? existing.activityLog : []),
              importEntry,
            ];
            payload.notes = unionNotes(existing.notes, incoming.notes);
            await put(CLIENTS_COLLECTION, docId, payload);
            updated++;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log(`[bulk-import] ${docId} failed: ${message}`);
          errors.push({ index, docId, error: message });
        }
      }

      log(`[bulk-import] ${actor} imported → created=${created} updated=${updated} skipped=${skipped} errors=${errors.length}`);
      res.json({ success: true, created, updated, skipped, errors, campaign });
    }),
  );
}
