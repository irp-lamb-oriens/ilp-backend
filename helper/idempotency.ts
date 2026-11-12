/**
 * helper/idempotency.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Write receipts. A browser that is not sure a change arrived (lost signal,
 * closed tab, two tabs sending the same saved change) sends it again with the
 * same `Idempotency-Key`. The first arrival runs; later arrivals get the first
 * answer back and nothing runs twice.
 *
 *   - applies to POST, PUT, PATCH and DELETE that carry a valid key;
 *   - a receipt belongs to one session (or one address when signed out), one
 *     method and one path: nobody can replay somebody else's answer;
 *   - the same key while the first is still running: 409 `request_in_progress`
 *     with Retry-After, never a second run;
 *   - answers kept: 2xx and final 4xx. Server errors, 408, 409, 425 and 429
 *     are forgotten so the retry runs for real;
 *   - kept in memory (no database reads or writes): 24 hours, the newest 5000,
 *     answers up to 64 KB. A server restart forgets them; the browser then
 *     sends once more and the write runs once more, as it would today.
 *
 * Every API answer also carries `X-ILP-Sync: 1`, which tells the site this
 * server understands the key (so an older server never receives the header).
 */

import { Buffer } from "node:buffer";
import type { NextFunction, Request, Response } from "express";

export const KEY_HEADER = "idempotency-key";
export const SYNC_HEADER = "X-ILP-Sync";
export const REPLAY_HEADER = "Idempotency-Replayed";

const KEY_RE = /^[A-Za-z0-9_-]{16,80}$/;
const WRITE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const NEVER_KEEP = new Set([408, 409, 425, 429]);
const MAX_ENTRIES = 5000;
const MAX_BODY_BYTES = 64 * 1024;
const KEEP_MS = 24 * 60 * 60 * 1000;

type Receipt =
  | { state: "pending"; at: number }
  | { state: "done"; at: number; status: number; type: string | null; body: string | Uint8Array | null };

const receipts = new Map<string, Receipt>();
let replays = 0;

export function clearReceipts(): void {
  receipts.clear();
  replays = 0;
}

export function receiptStats(): { entries: number; replays: number } {
  return { entries: receipts.size, replays };
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text) as BufferSource);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function header(req: Request, name: string): string {
  const v = req.headers[name];
  return typeof v === "string" ? v : Array.isArray(v) ? v[0] ?? "" : "";
}

/** Who is asking: the session token when there is one, else the caller's address. */
function owner(req: Request): string {
  const session = header(req, "authorization") || header(req, "x-dashboard-token") || header(req, "x-provider-token") ||
    header(req, "x-client-token");
  return session ? `s:${session}` : `ip:${header(req, "cf-connecting-ip") || req.ip || ""}`;
}

export function validKey(key: string): boolean {
  return KEY_RE.test(key);
}

function keep(status: number): boolean {
  return status >= 200 && status < 500 && !NEVER_KEEP.has(status);
}

function trim(now: number): void {
  for (const [k, r] of receipts) {
    if (receipts.size <= MAX_ENTRIES && now - r.at < KEEP_MS) break;
    receipts.delete(k);
  }
}

export function idempotency(opts: { now?: () => number } = {}) {
  const clock = opts.now ?? Date.now;
  return async (req: Request, res: Response, next: NextFunction) => {
    res.setHeader(SYNC_HEADER, "1");
    const key = header(req, KEY_HEADER);
    if (!key || !WRITE.has(req.method) || !validKey(key)) return next();

    let id: string;
    try {
      id = await sha256(`${owner(req)}|${req.method}|${(req.originalUrl || req.url || "").split("?")[0]}|${key}`);
    } catch {
      return next();
    }
    const now = clock();
    const seen = receipts.get(id);
    if (seen && now - seen.at < KEEP_MS) {
      if (seen.state === "pending") {
        res.setHeader("Retry-After", "1");
        res.status(409).json({ error: "This change is already being saved.", code: "request_in_progress" });
        return;
      }
      replays++;
      res.setHeader(REPLAY_HEADER, "true");
      res.status(seen.status);
      if (seen.body === null) return void res.end();
      if (seen.type) res.setHeader("Content-Type", seen.type);
      res.send(typeof seen.body === "string" ? seen.body : Buffer.from(seen.body));
      return;
    }

    receipts.delete(id);
    receipts.set(id, { state: "pending", at: now });
    trim(now);

    let captured: string | Uint8Array | null = null;
    let tooBig = false;
    const send = res.send.bind(res);
    // res.json ends in res.send, so one hook sees every JSON and text answer.
    res.send = ((body?: unknown) => {
      if (typeof body === "string") {
        if (body.length > MAX_BODY_BYTES) tooBig = true;
        else captured = body;
      } else if (body instanceof Uint8Array) {
        if (body.byteLength > MAX_BODY_BYTES) tooBig = true;
        else captured = new Uint8Array(body);
      }
      return send(body);
    }) as Response["send"];

    let settled = false;
    const settle = (finished: boolean) => {
      if (settled) return;
      settled = true;
      const mine = receipts.get(id);
      if (!mine || mine.state !== "pending") return;
      if (!finished || tooBig || !keep(res.statusCode)) return void receipts.delete(id);
      const type = res.getHeader("Content-Type");
      receipts.set(id, {
        state: "done",
        at: clock(),
        status: res.statusCode,
        type: typeof type === "string" ? type : null,
        body: captured,
      });
    };
    res.on("finish", () => settle(true));
    res.on("close", () => settle(false));
    next();
  };
}
