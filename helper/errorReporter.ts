/**
 * helper/errorReporter.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Error reporting and deep health (P1).
 *
 * reportError(err, ctx) writes one row to the `error_log` collection
 *   { message, route, actor, stack, at, kind, errorId, status? }
 * and, when SENTRY_DSN is set, posts the same event to Sentry's store
 * endpoint with fetch (no SDK). Never throws. Repeats of the same message on
 * the same route are reported once per minute, and at most 60 reports per
 * minute go out, so an error loop cannot flood Firestore or Sentry.
 *
 * Wiring (main.ts):
 *   installProcessErrorHandlers()   unhandled promise rejections + uncaught errors
 *   app.use(errorHandler)           last middleware: 5xx are reported, 4xx
 *                                   from body parsers (413, 400) pass through
 *   registerHealthRoutes(app)       GET /health (public) and GET /health/deep
 *
 * GET /health/deep needs header `x-health-token: $HEALTH_TOKEN` (404 when
 * HEALTH_TOKEN is unset, 401 on a wrong token). It reports Firestore read ok,
 * email transport configured, cron enabled, plus which optional services are
 * configured; 200 when Firestore and email are ok, else 503.
 *
 * Request bodies, cookies and headers are never recorded.
 */

import type { Express, NextFunction, Request, Response } from "express";
import post from "../db/post.ts";
import get from "../db/get.ts";
import log from "./log.ts";
import type { AuthedRequest } from "./auth/session.ts";

export const ERROR_COLLECTION = "error_log";

export interface ErrorContext {
  route?: string;
  actor?: string;
  kind?: "route" | "unhandledRejection" | "uncaughtException" | "job";
  status?: number;
}

const DEDUPE_MS = 60_000;
const MAX_PER_MINUTE = 60;
const recent = new Map<string, number>();
let windowStart = 0;
let windowCount = 0;

/** True when this error should be sent now (dedupe + global cap). Exported for tests. */
export function shouldReport(key: string, now = Date.now()): boolean {
  const prev = recent.get(key);
  if (prev !== undefined && now - prev < DEDUPE_MS) return false;
  if (now - windowStart >= 60_000) {
    windowStart = now;
    windowCount = 0;
  }
  if (windowCount >= MAX_PER_MINUTE) return false;
  windowCount++;
  recent.set(key, now);
  if (recent.size > 1000) recent.clear();
  return true;
}

/** Reset the throttle (tests). */
export function resetErrorThrottle(): void {
  recent.clear();
  windowStart = 0;
  windowCount = 0;
}

function hex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

function normalize(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) return { name: err.name || "Error", message: err.message || String(err), stack: err.stack };
  if (typeof err === "string") return { name: "Error", message: err };
  try {
    return { name: "Error", message: JSON.stringify(err) };
  } catch {
    return { name: "Error", message: String(err) };
  }
}

/** Parse SENTRY_DSN (https://<key>@<host>/<projectId>) into the store URL and key. */
export function parseSentryDsn(dsn: string | undefined): { url: string; key: string } | null {
  if (!dsn) return null;
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\/+|\/+$/g, "").split("/").pop();
    if (!u.username || !projectId) return null;
    const prefix = u.pathname.replace(/\/?[^/]+\/?$/, "");
    return { url: `${u.protocol}//${u.host}${prefix}/api/${projectId}/store/`, key: u.username };
  } catch {
    return null;
  }
}

/** Sentry event payload (store API, protocol v7). Exported for tests. */
export function sentryEvent(
  e: { name: string; message: string; stack?: string },
  ctx: ErrorContext,
  eventId: string,
  at: string,
): Record<string, unknown> {
  return {
    event_id: eventId,
    timestamp: at,
    platform: "javascript",
    level: "error",
    logger: "ilp-server",
    server_name: "ilp-api",
    environment: Deno.env.get("RENDER_EXTERNAL_URL") ? "production" : "development",
    message: { formatted: e.message.slice(0, 1000) },
    exception: { values: [{ type: e.name, value: e.message.slice(0, 1000) }] },
    tags: { route: ctx.route ?? "none", kind: ctx.kind ?? "route" },
    user: ctx.actor ? { email: ctx.actor } : undefined,
    extra: { stack: e.stack?.slice(0, 8000), status: ctx.status },
  };
}

async function sendToSentry(event: Record<string, unknown>): Promise<void> {
  const dsn = parseSentryDsn(Deno.env.get("SENTRY_DSN"));
  if (!dsn) return;
  const res = await fetch(dsn.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${dsn.key}, sentry_client=ilp-server/1.0`,
    },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) log(`[errorReporter] Sentry answered ${res.status}`, "error");
}

/** Record an error. Returns the error id (also when throttled). Never throws. */
export async function reportError(err: unknown, ctx: ErrorContext = {}): Promise<string> {
  const errorId = hex(16);
  const e = normalize(err);
  const at = new Date().toISOString();
  log(`[error] ${ctx.kind ?? "route"} ${ctx.route ?? ""} ${e.message} (id ${errorId})`, "error");
  if (!shouldReport(`${ctx.route ?? ""}|${e.message.slice(0, 200)}`)) return errorId;
  const row = {
    errorId,
    message: e.message.slice(0, 2000),
    route: ctx.route ?? null,
    actor: ctx.actor ?? null,
    stack: e.stack?.slice(0, 8000) ?? null,
    kind: ctx.kind ?? "route",
    status: ctx.status ?? null,
    at,
  };
  await Promise.allSettled([
    post(ERROR_COLLECTION, row).catch((x) =>
      log(`[errorReporter] error_log write failed: ${x instanceof Error ? x.message : x}`, "error")
    ),
    sendToSentry(sentryEvent(e, ctx, errorId, at)).catch((x) =>
      log(`[errorReporter] Sentry post failed: ${x instanceof Error ? x.message : x}`, "error")
    ),
  ]);
  return errorId;
}

function actorOf(req: Request): string | undefined {
  const r = req as AuthedRequest;
  return r.dashboardUser ?? r.providerUser ?? r.clientUser ?? undefined;
}

/** Route pattern when Express matched one (no ids in the grouping key), else the path. */
function routeOf(req: Request): string {
  const pattern = (req as Request & { route?: { path?: string }; baseUrl?: string }).route?.path;
  return `${req.method} ${pattern ? `${(req as Request & { baseUrl?: string }).baseUrl ?? ""}${pattern}` : req.path}`;
}

/** Express error middleware. Mount last. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const e = err as { status?: number; statusCode?: number; expose?: boolean; message?: string; type?: string };
  const status = Number(e?.status ?? e?.statusCode ?? 500);
  if (status >= 400 && status < 500) {
    // Client errors raised by middleware (body too large, bad JSON): answer, don't report.
    const message = status === 413
      ? "That upload is too large."
      : e?.expose && e.message ? e.message : "Bad request.";
    res.status(status).json({ error: message });
    return;
  }
  reportError(err, { route: routeOf(req), actor: actorOf(req), kind: "route", status: 500 })
    .then((errorId) => {
      if (!(res as Response & { headersSent?: boolean }).headersSent) {
        res.status(500).json({ error: "Internal server error.", errorId });
      }
    });
}

let processHandlersInstalled = false;

/** Report unhandled promise rejections and uncaught errors instead of losing them. */
export function installProcessErrorHandlers(): void {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;
  const g = globalThis as unknown as {
    addEventListener?: (type: string, fn: (ev: Event & { reason?: unknown; error?: unknown }) => void) => void;
  };
  g.addEventListener?.("unhandledrejection", (ev) => {
    ev.preventDefault?.(); // keep the server alive (Deno exits on unhandled rejections by default)
    reportError(ev.reason, { kind: "unhandledRejection" });
  });
  g.addEventListener?.("error", (ev) => {
    ev.preventDefault?.();
    reportError(ev.error ?? ev, { kind: "uncaughtException" });
  });
}

// ── Health ──────────────────────────────────────────────────────────────────

function sameToken(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function firestoreOk(): Promise<{ ok: boolean; ms: number; error?: string }> {
  const started = Date.now();
  try {
    await Promise.race([
      get("cronState", "health_probe"), // a missing doc (null) still proves the read path works
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout after 5 s")), 5000)),
    ]);
    return { ok: true, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: err instanceof Error ? err.message.slice(0, 200) : "failed" };
  }
}

/** Deep health snapshot. Exported for tests (pass a fake Firestore probe). */
export async function deepHealth(probe: () => Promise<{ ok: boolean; ms: number; error?: string }> = firestoreOk) {
  const env = (k: string) => !!Deno.env.get(k);
  const firestore = await probe();
  const email = { configured: env("SMTP_HOST") && env("SMTP_USER") && env("SMTP_PASS") };
  const baseUrl = Deno.env.get("RENDER_EXTERNAL_URL") ?? "";
  const cron = { enabled: Deno.env.get("CRON_RUNNER_ENABLED") === "true" && !!baseUrl && !baseUrl.includes("localhost") };
  const ok = firestore.ok && email.configured;
  return {
    ok,
    at: new Date().toISOString(),
    firestore,
    email,
    cron,
    services: {
      documentBucket: env("DOCUMENT_BUCKET"),
      backupBucket: env("BACKUP_BUCKET"),
      sentry: !!parseSentryDsn(Deno.env.get("SENTRY_DSN")),
      headerTokens: Deno.env.get("AUTH_HEADER_TOKENS") === "true",
    },
  };
}

export function registerHealthRoutes(app: Express): void {
  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });

  app.get("/health/deep", async (req: Request, res: Response) => {
    const expected = Deno.env.get("HEALTH_TOKEN");
    if (!expected) return res.status(404).json({ error: "Not found." });
    const given = String(req.headers["x-health-token"] ?? "");
    if (!sameToken(given, expected)) return res.status(401).json({ error: "Unauthorized." });
    const body = await deepHealth();
    res.setHeader("Cache-Control", "no-store");
    res.status(body.ok ? 200 : 503).json(body);
  });
}
