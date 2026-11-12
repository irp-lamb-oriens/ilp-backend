// deno-lint-ignore no-import-prefix
import { assert, assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { type AgreementDeps, type AgreementRecord, AGREEMENTS, agreementIdFor, finalizeAgreement, parseSignature, signAgreement, SIGNATURE_ERROR } from "../API/agreements/agreements.ts";
import { AGREEMENT_VERSION, agreementPlainText, agreementSections } from "../API/agreements/agreementText.ts";
import { agreementPdf } from "../API/agreements/agreementPdf.ts";
import { stripeTaxFields } from "../API/payments/membership.ts";
import { preflight } from "../scripts/preflight.ts";

type Doc = Record<string, unknown>;

function world() {
  const db = new Map<string, Doc>();
  const emails: Array<{ to: string; subject: string; key: string }> = [];
  const audits: string[] = [];
  let clock = "2026-11-11T15:00:00.000Z";
  const deps: AgreementDeps = {
    get: (c, id) => Promise.resolve(db.get(`${c}/${id}`) ?? null),
    put: (c, id, data) => {
      db.set(`${c}/${id}`, JSON.parse(JSON.stringify(data)));
      return Promise.resolve();
    },
    storePdf: (_c, _d, bytes) => Promise.resolve({ ok: true as const, fields: { storage: "inline" }, size: bytes.length, contentType: "application/pdf" }),
    buildPdf: agreementPdf,
    email: (m, key) => {
      emails.push({ to: m.to, subject: m.subject, key });
      return Promise.resolve();
    },
    audit: (e) => {
      audits.push(e.action);
      return Promise.resolve();
    },
    now: () => clock,
  };
  return { db, emails, audits, deps, set: (iso: string) => (clock = iso) };
}

Deno.test("agreement: signature parsing", () => {
  assertEquals(parseSignature({}, false), { signature: null });
  assertEquals(parseSignature({}, true), { error: SIGNATURE_ERROR });
  assertEquals(parseSignature({ signature: "  Mary   Ann  Hayes " }, true), { signature: "Mary Ann Hayes" });
  assertEquals(parseSignature({ signature: "12" }, true), { error: SIGNATURE_ERROR });
  assertEquals(parseSignature({ signature: "José Núñez", agreementVersion: AGREEMENT_VERSION }, true), { signature: "José Núñez" });
  assert("error" in parseSignature({ signature: "Mary Hayes", agreementVersion: "old" }, true));
});

Deno.test("agreement: text names the price, renewal, online cancellation and that ILP is not a law firm", () => {
  const text = agreementPlainText("https://internationallegalpartner.com");
  for (const needle of ["US$79.99", "US$100", "renews automatically every month", "/status/money/cancel", "not a law firm", "60 minutes", AGREEMENT_VERSION]) {
    assert(text.includes(needle), needle);
  }
  assertEquals(agreementSections("https://x.test").length, 8);
});

Deno.test("agreement: sign at join, file the signed PDF once on activation, email the member", async () => {
  const w = world();
  const rec = await signAgreement({ clientId: "mary_x_com", membershipId: "mem_1", email: "mary@x.com", fullName: "Mary Hayes", country: "CR", signature: "Mary Hayes", ip: "203.0.113.9", userAgent: "Safari" }, w.deps);
  assertEquals(rec.id, agreementIdFor("mem_1"));
  assertEquals(rec.version, AGREEMENT_VERSION);
  assertEquals(rec.textSha256.length, 64);
  assertEquals(await finalizeAgreement("mem_none", undefined, w.deps), null);

  w.set("2026-11-11T15:05:00.000Z");
  const done = await finalizeAgreement("mem_1", "2026-11-11T15:05:00.000Z", w.deps) as AgreementRecord;
  assertEquals(done.documentId, "doc_agr_mem_1");
  assertEquals(done.pdfSha256?.length, 64);
  const doc = w.db.get("member_documents/doc_agr_mem_1")!;
  assertEquals([doc.clientId, doc.kind, doc.contentType, doc.uploadedBy], ["mary_x_com", "membership_agreement", "application/pdf", "ILP"]);
  assert(Number(doc.size) > 5000);
  assertEquals(w.emails, [{ to: "mary@x.com", subject: "Your signed ILP membership agreement", key: "agreement_agr_mem_1" }]);

  // Replays (webhook retries) file nothing twice, and a later join retry cannot rewrite a filed agreement.
  await finalizeAgreement("mem_1", undefined, w.deps);
  assertEquals(w.emails.length, 1);
  const again = await signAgreement({ clientId: "mary_x_com", membershipId: "mem_1", email: "mary@x.com", fullName: "Mary Hayes", signature: "Someone Else" }, w.deps);
  assertEquals(again.signature, "Mary Hayes");
  assertEquals((w.db.get(`${AGREEMENTS}/agr_mem_1`) as unknown as AgreementRecord).finalizedAt, "2026-11-11T15:05:00.000Z");
  assertEquals(w.audits, ["agreement.signed", "agreement.filed"]);
});

Deno.test("agreement: the PDF is a real PDF", async () => {
  const bytes = await agreementPdf({ id: "agr_t", fullName: "Mary Hayes", email: "mary@x.com", signature: "Mary Hayes", signedAt: "2026-11-11T15:00:00.000Z", textSha256: "ab".repeat(32), draft: true }, "https://internationallegalpartner.com");
  assertEquals(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
});

Deno.test("stripe: tax fields only when STRIPE_TAX is on", () => {
  assertEquals([...stripeTaxFields(false, 2).keys()], []);
  const f = stripeTaxFields(true, 2);
  assertEquals(f.get("automatic_tax[enabled]"), "true");
  assertEquals(f.get("line_items[0][price_data][tax_behavior]"), "exclusive");
  assertEquals(f.get("line_items[1][price_data][tax_behavior]"), "exclusive");
  assertEquals(f.get("billing_address_collection"), "required");
});

Deno.test("preflight: a production-ready env has no blockers; the common mistakes are blockers", () => {
  const good: Record<string, string> = {
    SERVICE_ACCOUNT_KEY: "{}",
    JWT_SECRET: "x".repeat(40),
    OTP_PEPPER: "y".repeat(32),
    ALLOWED_ORIGINS: "https://internationallegalpartner.com",
    ADMIN_EMAILS: "a@internationallegalpartner.com",
    DEFAULT_CSM_EMAIL: "c@internationallegalpartner.com",
    PUBLIC_SITE_URL: "https://internationallegalpartner.com",
    FRONTEND_URL: "https://internationallegalpartner.com",
    PUBLIC_API_URL: "https://api.internationallegalpartner.com",
    SMTP_HOST: "smtp.x.com",
    SMTP_USER: "u",
    SMTP_PASS: "p",
    SMTP_FROM: "ILP <hello@internationallegalpartner.com>",
    CRON_RUNNER_ENABLED: "true",
    PAYMENTS_MODE: "stripe",
    STRIPE_SECRET_KEY: "sk_live_" + "a".repeat(40),
    STRIPE_ALLOW_LIVE: "true",
    STRIPE_TAX: "true",
    AGREEMENT_REQUIRED: "true",
    DOCUMENT_BUCKET: "ilp-docs",
    BACKUP_BUCKET: "ilp-backups",
    CALENDAR_SERVICE_ACCOUNT_KEY: "{}",
    GOOGLE_SUBJECT_EMAIL: "calls@internationallegalpartner.com",
    CALENDAR_ID: "primary",
    OPENROUTER_API_KEY: "k",
    REFERRALS_BANK_KEY: btoa("x".repeat(32)),
    HEALTH_TOKEN: "h",
    SENTRY_DSN: "https://s",
    PRIVACY_OWNER_EMAIL: "p@internationallegalpartner.com",
  };
  const run = (over: Record<string, string | undefined>) => preflight((k) => ({ ...good, ...over })[k]);
  assertEquals(run({}).filter((f) => f.level !== "ok"), []);
  const blockers = (over: Record<string, string | undefined>) => run(over).filter((f) => f.level === "blocker").map((f) => f.key);
  assertEquals(blockers({ STRIPE_ALLOW_LIVE: undefined }), ["STRIPE_ALLOW_LIVE"]);
  assertEquals(blockers({ PAYMENTS_DEMO_AUTOPAY: "true" }), ["PAYMENTS_DEMO_AUTOPAY"]);
  assertEquals(blockers({ REFERRALS_BANK_KEY: "not-a-32-byte-base64-key" }), ["REFERRALS_BANK_KEY"]);
  assertEquals(blockers({ CRON_RUNNER_ENABLED: "false" }), ["CRON_RUNNER_ENABLED"]);
  assertEquals(blockers({ GOOGLE_SUBJECT_EMAIL: "x@internationalrelocationpartner.com" }), ["GOOGLE_SUBJECT_EMAIL"]);
  assertEquals(blockers({ PUBLIC_SITE_URL: "http://localhost:3000" }), ["PUBLIC_SITE_URL"]);
  assert(!JSON.stringify(run({})).includes("sk_live_"));
});
