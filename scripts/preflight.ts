/**
 * scripts/preflight.ts — is this environment ready to take real members?
 *
 *   deno run --allow-env --allow-read scripts/preflight.ts            (reads .env + the process env)
 *   deno run --allow-env --allow-read scripts/preflight.ts --strict   (exit 1 on any blocker)
 *
 * Checks settings only (no network): every blocker is something that would
 * lose money, lose mail or leave a door open in production. Values are never
 * printed. Run it before each production deploy (on Render: in the Shell tab).
 */

export interface Finding {
  level: "blocker" | "warning" | "ok";
  key: string;
  message: string;
}

type Env = (name: string) => string | undefined;

const has = (env: Env, k: string) => !!env(k)?.trim();
const isUrl = (v: string | undefined) => !!v && /^https:\/\/[^\s/]+\.[^\s/]+/.test(v) && !/localhost|127\.0\.0\.1/.test(v);

/** Pure: findings for a set of env values. */
export function preflight(env: Env): Finding[] {
  const out: Finding[] = [];
  const blocker = (key: string, message: string) => out.push({ level: "blocker", key, message });
  const warning = (key: string, message: string) => out.push({ level: "warning", key, message });
  const ok = (key: string, message: string) => out.push({ level: "ok", key, message });
  const need = (key: string, why: string) => (has(env, key) ? ok(key, "set") : blocker(key, `not set: ${why}`));
  const longSecret = (key: string, why: string, min = 24) => {
    const v = env(key)?.trim() ?? "";
    if (!v) blocker(key, `not set: ${why}`);
    else if (v.length < min) blocker(key, `too short (${v.length} characters, need ${min}+)`);
    else ok(key, "set");
  };

  // Core
  need("SERVICE_ACCOUNT_KEY", "the database cannot be reached");
  longSecret("JWT_SECRET", "sessions cannot be signed");
  longSecret("OTP_PEPPER", "sign-in codes are hashed without a pepper", 16);
  if (!has(env, "ALLOWED_ORIGINS")) warning("ALLOWED_ORIGINS", "not set: the API only accepts internationallegalpartner.com");
  else ok("ALLOWED_ORIGINS", "set");
  if (env("AUTH_HEADER_TOKENS") === "true") blocker("AUTH_HEADER_TOKENS", "is true: seed tokens work in production. Unset it.");
  if (!has(env, "ADMIN_EMAILS") && !has(env, "OWNER_EMAILS")) blocker("ADMIN_EMAILS", "no admin: finance, settings, privacy and payouts answer 403 for everyone");
  else ok("ADMIN_EMAILS", "set");
  if (!has(env, "DEFAULT_CSM_EMAIL")) warning("DEFAULT_CSM_EMAIL", "not set: tasks for members with no CSM have no owner");

  // Site links
  for (const k of ["PUBLIC_SITE_URL", "FRONTEND_URL"]) {
    if (!isUrl(env(k))) blocker(k, "must be the https address of the live site (emails, Stripe returns and partner links use it)");
    else ok(k, "set");
  }
  if (!isUrl(env("PUBLIC_API_URL")) && !isUrl(env("RENDER_EXTERNAL_URL"))) warning("PUBLIC_API_URL", "not set: unsubscribe links may point at localhost");

  // Email
  for (const k of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"]) need(k, "no email leaves the server (sign-in codes, receipts, reminders)");
  if (env("CRON_RUNNER_ENABLED") !== "true") blocker("CRON_RUNNER_ENABLED", "is not true: queued emails, renewals, reminders, backups and commission approvals never run");
  else ok("CRON_RUNNER_ENABLED", "true");

  // Payments
  const mode = env("PAYMENTS_MODE")?.trim();
  const key = env("STRIPE_SECRET_KEY")?.trim() ?? "";
  if (mode === "stripe") {
    if (!key) blocker("STRIPE_SECRET_KEY", "not set while PAYMENTS_MODE=stripe: nobody can join");
    else if (/^(sk|rk)_live_/.test(key)) {
      if (env("STRIPE_ALLOW_LIVE") === "true") ok("STRIPE_SECRET_KEY", "live key, live mode allowed");
      else blocker("STRIPE_ALLOW_LIVE", "a live Stripe key is set but STRIPE_ALLOW_LIVE is not true: checkout fails");
    } else if (/^(sk|rk)_test_/.test(key)) warning("STRIPE_SECRET_KEY", "is a TEST key: members are not charged real money");
    else blocker("STRIPE_SECRET_KEY", "does not look like a Stripe secret key (sk_live_… or sk_test_…)");
    if (env("STRIPE_TAX") !== "true") warning("STRIPE_TAX", "is not true: Stripe adds no sales tax or VAT at checkout (turn Stripe Tax on in Stripe first)");
  } else {
    warning("PAYMENTS_MODE", "is not stripe: members are activated by staff with Mark paid, no card is charged");
  }
  if (env("PAYMENTS_DEMO_AUTOPAY") === "true") blocker("PAYMENTS_DEMO_AUTOPAY", "is true: people become members without paying");

  // Agreement, documents, backups
  if (env("AGREEMENT_REQUIRED") !== "true") warning("AGREEMENT_REQUIRED", "is not true: a join without a signed membership agreement is accepted");
  else ok("AGREEMENT_REQUIRED", "true");
  need("DOCUMENT_BUCKET", "members cannot upload documents and signed agreements are not filed");
  need("BACKUP_BUCKET", "there is no daily database backup");

  // Calls
  for (const k of ["CALENDAR_SERVICE_ACCOUNT_KEY", "GOOGLE_SUBJECT_EMAIL", "CALENDAR_ID"]) need(k, "booked calls get no Meet link");
  if (/internationalrelocationpartner\.com/i.test(env("GOOGLE_SUBJECT_EMAIL") ?? "")) {
    blocker("GOOGLE_SUBJECT_EMAIL", "still points at the IRP Workspace user: calls would be organized by IRP");
  }
  if (!has(env, "OPENROUTER_API_KEY")) warning("OPENROUTER_API_KEY", "not set: no AI summary drafts or assistant answers");

  // Referrals
  const bank = env("REFERRALS_BANK_KEY")?.trim() ?? "";
  let bankOk = false;
  try {
    bankOk = !!bank && atob(bank).length === 32;
  } catch {
    bankOk = false;
  }
  if (!bank) warning("REFERRALS_BANK_KEY", "not set: partners cannot save bank details (generate: openssl rand -base64 32)");
  else if (!bankOk) blocker("REFERRALS_BANK_KEY", "is not 32 random bytes in base64 (generate: openssl rand -base64 32)");
  else ok("REFERRALS_BANK_KEY", "set");

  // Operations
  if (!has(env, "HEALTH_TOKEN")) warning("HEALTH_TOKEN", "not set: the uptime monitor cannot call /health/deep");
  if (!has(env, "SENTRY_DSN")) warning("SENTRY_DSN", "not set: errors are only in the error_log collection");
  if (!has(env, "PRIVACY_OWNER_EMAIL")) warning("PRIVACY_OWNER_EMAIL", "not set: privacy requests go to the default CSM");
  return out;
}

if (import.meta.main) {
  try {
    const { loadSync } = await import("dotenv/mod.ts");
    loadSync({ export: true, allowEmptyValues: true, examplePath: null });
  } catch {
    // no .env file: the process env is used as is
  }
  const findings = preflight((k) => Deno.env.get(k));
  const mark = { blocker: "BLOCKER", warning: "warning", ok: "ok     " };
  for (const level of ["blocker", "warning", "ok"] as const) {
    for (const f of findings.filter((x) => x.level === level)) console.log(`${mark[level]}  ${f.key}: ${f.message}`);
  }
  const blockers = findings.filter((f) => f.level === "blocker").length;
  const warnings = findings.filter((f) => f.level === "warning").length;
  console.log(`\n${blockers} blocker(s), ${warnings} warning(s).${blockers ? " Not ready for real members." : " No blockers."}`);
  if (blockers && Deno.args.includes("--strict")) Deno.exit(1);
}
