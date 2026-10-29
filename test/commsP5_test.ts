// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { indexHtml, previewFile, renderAll, setPreviewEnv } from "../scripts/renderEmailPreviews.ts";
import { DEFAULT_PLAYBOOKS, renderPlaybookEmail } from "../API/csm/playbooks.ts";
import { preCallLawyerEmail } from "../API/routing/emails.ts";
import { pricingRequestEmail } from "../API/dashboard/pricingRequestsRouter.ts";
import { bugReportEmail } from "../API/dashboard/bugReportHandler.ts";
import { quotePendingApprovalEmail } from "../API/dashboard/quotesRouter.ts";

/**
 * COMMS-P5: verification sweep. Every email the server can send is rendered
 * with the real templates (scripts/renderEmailPreviews.ts) and checked
 * against the copy and compliance rules; plus the small fixes of this phase.
 * Run: deno test --allow-env --allow-read test/commsP5_test.ts
 */

const DASHES = /—|–/;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const FOOT = "not a law firm";
const UNSUB = "/api/retention/unsubscribe";

Deno.test("previews: every email renders, unique ids, no dashes or emojis, English", () => {
  setPreviewEnv();
  const all = renderAll();
  assert(all.length >= 90, `only ${all.length} previews`);
  assertEquals(new Set(all.map((p) => p.id)).size, all.length);
  for (const p of all) {
    assert(p.subject.trim() && p.html.trim(), p.id);
    assert(!DASHES.test(p.subject + p.html), `${p.id}: em or en dash`);
    assert(!EMOJI.test(p.subject + p.html), `${p.id}: emoji`);
    assert(!/\b(Hola|usted|Mañana|Olá|você)\b/.test(p.html), `${p.id}: not English`);
  }
  const index = indexHtml(all, "2026-10-29T00:00:00Z");
  for (const p of all) assert(index.includes(`href="${p.id}.html"`), p.id);
  assert(previewFile(all[0]).includes("Subject:"));
});

Deno.test("previews: member and lead emails carry the legal footer; service and marketing ones the unsubscribe link", () => {
  setPreviewEnv();
  for (const p of renderAll().filter((x) => x.recipient === "member" || x.recipient === "lead")) {
    assert(p.html.includes(FOOT), `${p.id}: legal footer missing`);
    if (p.cls === "service" || p.cls === "marketing") assert(p.html.includes(UNSUB), `${p.id}: unsubscribe link missing`);
  }
});

Deno.test("CSM playbooks: service emails carry the unsubscribe link, transactional ones do not", () => {
  const url = "https://api.example.com/api/retention/unsubscribe?c=cli_x";
  for (const p of Object.values(DEFAULT_PLAYBOOKS)) {
    const m = renderPlaybookEmail(p, { firstName: "Margaret", csmEmail: "carla.mendez@example.com", siteUrl: "https://app.example.com", unsubscribeUrl: url });
    assertEquals(m.html.includes(url), p.emailClass !== "transactional", p.id);
    assert(m.html.includes(FOOT), p.id);
  }
  assertEquals(DEFAULT_PLAYBOOKS.payment_failed.emailClass, "transactional");
  assertEquals(DEFAULT_PLAYBOOKS.welcome_call.emailClass, "service");
});

Deno.test("pre-call email: an unknown language falls back to English", () => {
  const m = preCallLawyerEmail({
    lang: "xx" as any, kind: "booked", lawyerName: "Daniela", when: "Thursday", durationMin: 20, meetUrl: null, briefUrl: "https://app.example.com/lawyer",
    brief: { memberName: "Margaret Ellison", country: "Costa Rica", memberZone: "America/Chicago", question: null, matter: null, facts: [], obligations: [], previous: [], documents: [] },
  });
  assert(/^Hi Daniela/.test(m.text), m.text.slice(0, 40));
  assert(!/Hola/.test(m.html));
});

Deno.test("internal emails: escaped once, no dashes or emojis (pricing request, bug report, quote approval)", () => {
  const pr = pricingRequestEmail({ index: 2, clientName: "Tom & Ann <Reed>", clientEmail: "tom@example.com", actor: "ana@example.com", options: [], originLabel: null, originNotes: "A & B", destinationLabel: "Costa Rica", destinationNotes: null });
  assertEquals(pr.subject, "Pricing request #2: Tom & Ann <Reed>");
  assert(pr.html.includes("Tom &amp; Ann &lt;Reed&gt;") && pr.html.includes("not given (A &amp; B)") && !pr.html.includes("&amp;amp;"), pr.html);
  assert(!DASHES.test(pr.subject + pr.html));
  const bug = bugReportEmail({ title: "<b>Broken</b>", actor: "ana@example.com" });
  assertEquals(bug.subject, "Bug report: <b>Broken</b>");
  assert(bug.html.includes("&lt;b&gt;Broken&lt;/b&gt;") && bug.html.includes("URL: not given") && !EMOJI.test(bug.subject) && !DASHES.test(bug.html));
  const q = quotePendingApprovalEmail({ by: "Lawyer", actor: "d@example.com", quoteTitle: "A <b>", clientId: "c1", note: " <i>x</i> " });
  assert(q.html.includes("Lawyer <strong>d@example.com</strong>") && q.html.includes("A &lt;b&gt;") && q.html.includes("&lt;i&gt;x&lt;/i&gt;"));
});
