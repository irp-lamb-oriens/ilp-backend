import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import post from "../../db/post.ts";
import get from "../../db/get.ts";
import put from "../../db/put.ts";
import log from "../../helper/log.ts";
import { sanitizeStr } from "../../helper/sanitize.ts";
import { emailToDocId } from "../../helper/auth/otp.ts";
import patch from "../../db/patch.ts";
import rateLimit from "express-rate-limit";
import { enqueueEmail } from "../../helper/emailQueue.ts";
import { COLLECTIONS, countryName as nameOf, type CountryCode, type Lead, toCountryCode } from "../../schemas/contracts.ts";
import { type CheckFinding, evaluateCheck, normalizeAnswers } from "./deadlineCheck.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CLIENTS_COLLECTION = "clients";

/** Map an ISO alpha-2 code to its display name, falling back to the code. */
function countryName(code: string): string {
  return nameOf(code);
}

/** Per-IP limit for the public check (on top of the global /api limiter). */
const checkLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many checks from this connection. Try again in a few minutes." },
  validate: { trustProxy: false },
});

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function findingsEmailHtml(findings: CheckFinding[], country: CountryCode): string {
  const site = Deno.env.get("PUBLIC_SITE_URL") || "https://ilp.legal";
  const rows = findings.length
    ? findings.map((f) => {
      // Low-confidence items never show a firm date; undated items show their rule in words.
      const date = f.confidence === "low"
        ? "Ask your lawyer to confirm this date"
        : f.dueAt
        ? new Date(f.dueAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
        : f.dueText ?? "";
      return `<li style="margin:0 0 16px"><strong>${esc(date)}</strong> &middot; ${esc(f.title)}<br>` +
        `<span style="color:#4a5a66">${esc(f.meaning)}</span></li>`;
    }).join("")
    : "<li>Nothing dated came up from your answers. Rules change, so it is worth checking again each year.</li>";
  return `<div style="font-family:Helvetica,Arial,sans-serif;font-size:17px;line-height:1.6;color:#202a33;max-width:560px">
<p>Here is what may apply to you in ${esc(countryName(country))}, based on your answers. These are general dates, not legal advice; a lawyer can confirm what applies to you.</p>
<ul style="padding-left:20px">${rows}</ul>
<p><a href="${esc(site)}/join" style="color:#123b5d">Have a lawyer review this with ILP</a></p></div>`;
}

/**
 * Public lead capture. Lower-friction than a full profile: the landing page
 * collects name/email/country/topic and persists a time-stamped lead for
 * follow-up. Mirrors IRP-funnel's public capture router (API/users/captureRouter).
 *
 * Also promotes the lead into the `clients` collection (the flywheel's source
 * of truth) so the customer immediately has a matter the portal, deadlines,
 * and push notifications can act on. Promotion is non-destructive: an existing
 * client doc is never overwritten.
 */
export default (app: Express) => {
  log("Leads router initialized.");

  /**
   * Free deadline check (W3). Public, no login.
   *   POST /api/leads/deadline-check { answers, email?, name? }
   * Without an email: returns findings only (nothing stored), so the visitor
   * sees results before giving anything. With an email: stores a `leads`
   * record (contracts.ts Lead), queues the findings by email, returns leadId.
   * Findings come from CHECK_RULES in the country catalog.
   */
  app.post(
    "/api/leads/deadline-check",
    checkLimiter,
    asyncHandler(async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { answers, error } = normalizeAnswers(body.answers);
      if (!answers) return res.status(400).json({ error });

      const findings = evaluateCheck(answers);
      const email = sanitizeStr(body.email).toLowerCase();
      if (!email) return res.status(200).json({ findings, saved: false });
      if (!EMAIL_RE.test(email) || email.length > 254) {
        return res.status(400).json({ error: "Enter a valid email address." });
      }

      const name = sanitizeStr(body.name).slice(0, 120);
      const id = `lead_${crypto.randomUUID()}`;
      const lead: Lead = {
        id,
        email,
        country: answers.country,
        answers,
        findings,
        source: "deadline_check",
        createdAt: new Date().toISOString(),
        ...(name ? { name } : {}),
      };
      await patch(COLLECTIONS.leads, id, lead as unknown as Record<string, unknown>);
      log(`[leads] deadline check saved ${id} (${findings.length} findings)`, "leads");

      // Best effort: the visitor already sees the results on screen.
      enqueueEmail({
        to: email,
        subject: "Your free deadline check from ILP",
        html: findingsEmailHtml(findings, answers.country),
      }).catch((err) => log(`[leads] findings email not queued: ${err}`, "leads"));

      res.status(201).json({ findings, saved: true, leadId: id });
    }),
  );

  app.post(
    "/api/leads",
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as Record<string, unknown> | undefined;

      const email = sanitizeStr(body?.email).toLowerCase();
      const country = toCountryCode(body?.country) ?? sanitizeStr(body?.country).toUpperCase();
      const name = sanitizeStr(body?.name);
      const topic = sanitizeStr(body?.topic);
      const consent = body?.consent === true;

      if (!email || !EMAIL_RE.test(email)) {
        return res.status(400).json({ error: "A valid email is required" });
      }
      if (!country) {
        return res.status(400).json({ error: "country is required" });
      }

      const id = await post("leads", {
        name,
        email,
        country,
        topic,
        consent,
        source: "landing_hero",
        createdAt: new Date().toISOString(),
      });

      // Promote to a client doc so the flywheel (portal, deadlines, push) can
      // act on this customer immediately. Read-then-create: never clobber an
      // existing client that already carries real matter data.
      const clientId = emailToDocId(email);
      const existing = await get(CLIENTS_COLLECTION, clientId).catch(() => null);
      if (!existing) {
        const now = new Date().toISOString();
        await put(CLIENTS_COLLECTION, clientId, {
          name: name || "",
          email,
          jurisdiction: countryName(country),
          legalMatter: topic || "",
          stage: "intake",
          source: "landing_hero",
          consent,
          deadlines: {},
          createdAt: now,
          updatedAt: now,
        });
        log(`[leads] promoted ${email} to client ${clientId}`, "leads");
      }

      res.status(201).json({ id, clientId });
    })
  );
};