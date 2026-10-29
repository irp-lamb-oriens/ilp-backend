/**
 * API/dashboard/bugReportHandler.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Bug-report channel for the ILP dashboard. Persists a report to the
 * `bug_reports` collection and notifies the team via the email queue.
 */

import type { Request, Response } from "express";
import post from "../../db/post.ts";
import { enqueueEmail } from "../../helper/emailQueue.ts";
import log from "../../helper/log.ts";

const TEAM_EMAIL = Deno.env.get("TEAM_EMAIL") ?? "team@internationallegalpartner.com";

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The team email for a bug report (COMMS-P5: pure, escaped, exported for the email previews). */
export function bugReportEmail(r: { title: string; description?: string; url?: string; actor: string }): { subject: string; html: string } {
  return {
    subject: `Bug report: ${r.title}`,
    html: `<div style="font-family:sans-serif;max-width:540px">
        <h2>Bug report</h2>
        <p><strong>${esc(r.title)}</strong></p>
        <p>${esc(r.description || "(no description)")}</p>
        <p>URL: ${esc(r.url || "not given")}</p>
        <p>Reported by: ${esc(r.actor)}</p>
      </div>`,
  };
}

export async function handleBugReport(
  req: Request,
  res: Response,
): Promise<void> {
  const actor = (req as Request & { dashboardUser?: string }).dashboardUser ?? "unknown";
  const { title, description, url, screenshot } = req.body ?? {};

  if (!title || typeof title !== "string" || !title.trim()) {
    res.status(400).json({ error: "title is required." });
    return;
  }

  const report = {
    title: title.trim(),
    description: typeof description === "string" ? description.trim() : "",
    url: typeof url === "string" ? url : "",
    screenshot: typeof screenshot === "string" ? screenshot.slice(0, 2_000_000) : null,
    reportedBy: actor,
    createdAt: new Date().toISOString(),
    status: "open",
  };

  const id = await post("bug_reports", report);

  void enqueueEmail(
    { to: TEAM_EMAIL, ...bugReportEmail({ title: report.title, description: report.description, url: report.url, actor }) },
    `bug_${id}`,
  ).catch((e) => log(`[bug-report] team email failed: ${e}`));

  log(`[bug-report] ${actor} filed "${report.title}"`);
  res.json({ success: true, id });
}