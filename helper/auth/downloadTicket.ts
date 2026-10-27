/**
 * helper/auth/downloadTicket.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Single-use download tickets (AUTH). Sessions travel as a Bearer header, so
 * a plain `<a href>` to an API file route carries no credentials. The front
 * end prefers fetching the file as a blob with the Bearer header; when it
 * must hand the URL to the browser instead, it asks for a ticket:
 *
 *   POST /api/download-ticket   { path: "/api/…/file" }   (Bearer required)
 *     → { ticket, url, expiresAt }   valid 60 s, one use
 *
 * and opens `${API}${path}?ticket=<ticket>`. The ticket is stored hashed
 * (SHA-256) in `download_tickets`, bound to the caller's session and to that
 * exact path. `?ticket=` is honoured only on DOWNLOAD_ROUTES (GET): the
 * middleware consumes the ticket and turns it into the session's Bearer
 * header, so the route's own auth and access checks (and audit rows) run
 * unchanged. Any other `?token=`/`?ticket=` is ignored.
 */

import type { Express, NextFunction, Request, Response } from "express";
import type { PortalRole } from "./audit.ts";
import { generateSessionToken } from "./otp.ts";
import { CLIENT_SESSION_MAX_AGE_MS, roleTokens } from "./cookies.ts";
import { SESSION_COLLECTION } from "./sessionHooks.ts";
import { sessionStore } from "./sessionStore.ts";
import log from "../log.ts";

export const TICKET_COLLECTION = "download_tickets";
export const TICKET_TTL_MS = 60_000;

/** GET routes that stream a file, and the session role that may ask for a ticket. */
export const DOWNLOAD_ROUTES: Array<{ re: RegExp; role: PortalRole }> = [
  { re: /^\/api\/client-status\/me\/documents\/[^/]+\/file$/, role: "client" },
  { re: /^\/api\/privacy\/me\/export$/, role: "client" },
  { re: /^\/api\/dashboard\/members\/[^/]+\/documents\/[^/]+\/file$/, role: "staff" },
  { re: /^\/api\/dashboard\/privacy\/members\/[^/]+\/export$/, role: "staff" },
  { re: /^\/api\/dashboard\/clients\/[^/]+\/quotes\/[^/]+\/contract-pdf$/, role: "staff" },
  { re: /^\/api\/provider\/members\/[^/]+\/documents\/[^/]+\/file$/, role: "lawyer" },
  { re: /^\/api\/provider\/clients\/[^/]+\/quotes\/[^/]+\/contract-pdf$/, role: "lawyer" },
];

/** The role whose session may open `path` with a ticket, or null if it is not a download route. Pure. */
export function downloadRole(path: string): PortalRole | null {
  for (const r of DOWNLOAD_ROUTES) if (r.re.test(path)) return r.role;
  return null;
}

/** SHA-256 hex of a ticket: the stored doc id (the ticket itself is never stored). */
export async function hashTicket(ticket: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ticket));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

interface TicketDoc {
  role: PortalRole;
  path: string;
  /** The session the ticket stands in for (doc id in the role's session collection). */
  session: string;
  email: string;
  createdAt: string;
  expiresAt: string;
}

/** Hashes consumed by this process: a second use is refused even if the Firestore delete lags. */
const consumed = new Set<string>();

/**
 * Issue a ticket for `path` from the caller's own session of the path's role.
 * Returns null when the path is not a download route or there is no live
 * session of that role.
 */
export async function issueTicket(
  req: Request,
  path: string,
  now = Date.now(),
): Promise<{ ticket: string; expiresAt: string } | null> {
  const role = downloadRole(path);
  if (!role) return null;
  let session: { token: string; email: string } | null = null;
  for (const t of roleTokens(req, role)) {
    const doc = await sessionStore.get(SESSION_COLLECTION[role], t);
    if (!doc?.email) continue;
    const exp = doc.expiresAt ? new Date(String(doc.expiresAt)).getTime() : NaN;
    if (Number.isFinite(exp) && exp < now) continue;
    const created = doc.createdAt ? new Date(String(doc.createdAt)).getTime() : NaN;
    if (role === "client" && Number.isFinite(created) && now - created > CLIENT_SESSION_MAX_AGE_MS) continue;
    session = { token: t, email: String(doc.email) };
    break;
  }
  if (!session) return null;
  const ticket = generateSessionToken();
  const expiresAt = new Date(now + TICKET_TTL_MS).toISOString();
  const doc: TicketDoc = {
    role,
    path,
    session: session.token,
    email: session.email,
    createdAt: new Date(now).toISOString(),
    expiresAt,
  };
  await sessionStore.put(TICKET_COLLECTION, await hashTicket(ticket), doc as unknown as Record<string, unknown>);
  return { ticket, expiresAt };
}

/**
 * Consume a ticket for `path`: the session token it stands in for, or null
 * (unknown, used, expired, or issued for another path). Single use: the
 * ticket document is deleted on the first attempt, valid or not.
 */
export async function consumeTicket(ticket: string, path: string, now = Date.now()): Promise<string | null> {
  if (!ticket) return null;
  const id = await hashTicket(ticket);
  if (consumed.has(id)) return null;
  const doc = (await sessionStore.get(TICKET_COLLECTION, id)) as unknown as TicketDoc | null;
  if (!doc) return null;
  consumed.add(id);
  if (consumed.size > 10_000) consumed.clear();
  await sessionStore.remove(TICKET_COLLECTION, id).catch((err: unknown) =>
    log(`[download-ticket] could not delete a used ticket: ${err instanceof Error ? err.message : err}`, "error")
  );
  if (doc.path !== path) return null;
  if (!doc.expiresAt || new Date(doc.expiresAt).getTime() < now) return null;
  if (downloadRole(path) !== doc.role) return null;
  return doc.session || null;
}

/**
 * Middleware (before the routers): on a GET to a download route carrying
 * `?ticket=`, swap the ticket for the session's Bearer header. Every other
 * request passes through untouched.
 */
export async function downloadTicketAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const ticket = typeof req.query?.ticket === "string" ? req.query.ticket : "";
  if (!ticket || req.method !== "GET" || !downloadRole(req.path)) return next();
  try {
    const session = await consumeTicket(ticket, req.path);
    if (!session) {
      res.status(401).json({ error: "This download link has expired. Go back and try the download again." });
      return;
    }
    // The ticket's session is the only credential for this request.
    for (const h of ["x-dashboard-token", "x-provider-token", "x-client-token", "cookie"]) delete req.headers[h];
    req.headers.authorization = `Bearer ${session}`;
    next();
  } catch (err) {
    log(`[download-ticket] ${err instanceof Error ? err.message : err}`, "error");
    res.status(401).json({ error: "This download link has expired. Go back and try the download again." });
  }
}

/** POST /api/download-ticket { path } → { ticket, url, expiresAt } (Bearer session of the path's role). */
export function downloadTicketRoutes(app: Express): void {
  app.use(downloadTicketAuth);
  app.post("/api/download-ticket", async (req: Request, res: Response) => {
    const raw = typeof req.body?.path === "string" ? req.body.path.trim() : "";
    const path = raw.split("?")[0];
    if (!path || !downloadRole(path)) {
      return res.status(400).json({ error: "This file cannot be downloaded with a ticket." });
    }
    try {
      const issued = await issueTicket(req, path);
      if (!issued) return res.status(401).json({ error: "Authentication required." });
      res.json({ ticket: issued.ticket, expiresAt: issued.expiresAt, url: `${path}?ticket=${encodeURIComponent(issued.ticket)}` });
    } catch (err) {
      log(`[download-ticket] issue failed: ${err instanceof Error ? err.message : err}`, "error");
      res.status(500).json({ error: "Could not prepare the download. Try again." });
    }
  });
}
