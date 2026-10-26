/**
 * API/privacy/cspReport.ts — Content-Security-Policy violation reports (P6).
 *
 *   POST /api/csp-report   no auth; body is application/csp-report (report-uri,
 *                          one object) or application/reports+json (Reporting
 *                          API, an array). Always answers 204.
 *
 * The site's CSP (frontend/src/middleware.ts) points report-uri / report-to
 * here. Reports land in `error_log` with kind "csp" (query error_log where
 * kind == "csp" to review them; the privacy retention job deletes error_log
 * rows after RETENTION_ERROR_LOG_DAYS). Rate limits: 20 requests per minute per
 * IP (express-rate-limit), the same violation (directive + blocked origin +
 * page path) once per 10 minutes, and at most 120 rows per hour overall.
 * Query strings and fragments are dropped from URLs so no tokens or emails
 * from a URL are stored.
 */

import express, { type Express, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import post from "../../db/post.ts";
import log from "../../helper/log.ts";

type Doc = Record<string, unknown>;

export interface CspViolation {
  directive: string;
  blocked: string;
  page: string;
  disposition: string; // "enforce" | "report"
  source?: string; // file:line when the browser gave one
  sample?: string;
}

/** Keep scheme + host + path only ("inline", "eval", "data" stay as is). */
export function cleanUri(v: unknown): string {
  if (typeof v !== "string" || !v) return "";
  const s = v.trim().slice(0, 500);
  if (/^(inline|eval|data|blob|self|wasm-eval|trusted-types-policy|trusted-types-sink)$/i.test(s)) return s.toLowerCase();
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}${u.pathname}`.slice(0, 300);
  } catch {
    return s.replace(/[?#].*$/, "").slice(0, 300);
  }
}

/** Pure: normalize both report formats into a list of violations. */
export function parseCspReports(body: unknown): CspViolation[] {
  const items: Doc[] = [];
  if (Array.isArray(body)) {
    for (const r of body) {
      if (r && typeof r === "object" && (r as Doc).type === "csp-violation" && typeof (r as Doc).body === "object") {
        items.push((r as Doc).body as Doc);
      }
    }
  } else if (body && typeof body === "object" && typeof (body as Doc)["csp-report"] === "object") {
    const r = (body as Doc)["csp-report"] as Doc;
    items.push({
      effectiveDirective: r["effective-directive"] ?? r["violated-directive"],
      blockedURL: r["blocked-uri"],
      documentURL: r["document-uri"],
      disposition: r.disposition,
      sourceFile: r["source-file"],
      lineNumber: r["line-number"],
      sample: r["script-sample"],
    });
  }
  return items.slice(0, 20).map((b) => {
    const src = cleanUri(b.sourceFile);
    const v: CspViolation = {
      directive: String(b.effectiveDirective ?? "unknown").slice(0, 60),
      blocked: cleanUri(b.blockedURL) || "unknown",
      page: cleanUri(b.documentURL),
      disposition: b.disposition === "report" ? "report" : "enforce",
    };
    if (src) v.source = `${src}${typeof b.lineNumber === "number" ? `:${b.lineNumber}` : ""}`;
    if (typeof b.sample === "string" && b.sample) v.sample = b.sample.slice(0, 80);
    return v;
  });
}

const DEDUPE_MS = 10 * 60_000;
const HOUR_CAP = 120;
const seen = new Map<string, number>();
let hourStart = 0;
let hourCount = 0;

/** True when this violation should be stored now. Exported for tests. */
export function shouldStore(v: CspViolation, now = Date.now()): boolean {
  const key = `${v.directive}|${v.blocked}|${v.page}`;
  const prev = seen.get(key);
  if (prev !== undefined && now - prev < DEDUPE_MS) return false;
  if (now - hourStart >= 3_600_000) {
    hourStart = now;
    hourCount = 0;
  }
  if (hourCount >= HOUR_CAP) return false;
  hourCount++;
  seen.set(key, now);
  if (seen.size > 2000) seen.clear();
  return true;
}

export function resetCspThrottle(): void {
  seen.clear();
  hourStart = 0;
  hourCount = 0;
}

const reportBody = express.json({
  type: ["application/csp-report", "application/reports+json", "application/json"],
  limit: "64kb",
});

const limiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: false,
  legacyHeaders: false,
  validate: { trustProxy: false },
  handler: (_req: Request, res: Response) => {
    res.status(204).end();
  },
});

export function registerCspReport(app: Express): void {
  app.post("/api/csp-report", limiter, reportBody, async (req: Request, res: Response) => {
    res.status(204).end();
    try {
      const at = new Date().toISOString();
      for (const v of parseCspReports(req.body)) {
        if (!shouldStore(v)) continue;
        await post("error_log", {
          errorId: `csp_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
          kind: "csp",
          message: `CSP ${v.disposition === "report" ? "report-only" : "blocked"}: ${v.directive} ${v.blocked}`,
          route: v.page || null,
          csp: v,
          at,
        });
      }
    } catch (err) {
      log(`[csp-report] could not store report: ${err instanceof Error ? err.message : err}`, "error");
    }
  });
}
