/**
 * scripts/devWorld.ts — the real API on an in-memory database, for local QA.
 * ──────────────────────────────────────────────────────────────────────────
 * Starts main.ts with every outside call (Firestore, Google, the LLM) answered
 * by test/e2e/fakeWorld.ts, loads the placeholder seed and a few "real"
 * records next to it, and prints ready-made sign-in tokens. Nothing is read
 * from or written to the production project, no email is sent, no card is
 * charged: SMTP, Stripe and push are switched off before the server loads and
 * any network call the fake does not know fails.
 *
 *   cd server
 *   deno run --allow-net --allow-env --allow-read scripts/devWorld.ts [--size=demo|pilot] [--seed=7] [--port=8000] [--no-real]
 *
 * Then run the site against it (frontend/: NEXT_PUBLIC_API_URL=http://localhost:8000)
 * and paste a token into localStorage (the key is printed), or open
 * /dashboard#… as printed. Data lives in memory: a restart starts over.
 *
 * Used for the dashboard QA passes (placeholder data in and out) and for
 * giving QA signed-in screens without touching production.
 */

import { fakeServiceAccount, installFakeWorld } from "../test/e2e/fakeWorld.ts";
import { buildPlaceholderData, type Doc, type SeedSize } from "./placeholderData.ts";

const arg = (name: string, fallback: string) => Deno.args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const size = arg("size", "demo") as SeedSize;
const seed = Number(arg("seed", "7"));
const port = arg("port", "8000");
const withReal = !Deno.args.includes("--no-real");

const ADMIN = "admin@ilp.test";
const STAFF = "staff@ilp.test";
const CSM = "csm@ilp.test";

// Before anything from the server loads: nothing here may reach the outside.
const env: Record<string, string> = {
  SERVICE_ACCOUNT_KEY: await fakeServiceAccount(),
  CALENDAR_SERVICE_ACCOUNT_KEY: "",
  CALENDAR_ID: "calls@ilp.test",
  GOOGLE_SUBJECT_EMAIL: "calls@ilp.test",
  PAYMENTS_MODE: "manual",
  STRIPE_SECRET_KEY: "",
  STRIPE_PUBLIC_API_KEY: "",
  SMTP_HOST: "",
  SMTP_USER: "",
  SMTP_PASS: "",
  VAPID_PUBLIC_KEY: "",
  VAPID_PRIVATE_KEY: "",
  OPENAI_API_KEY: "",
  OPENROUTER_API_KEY: "dev-world",
  OPENROUTER_KEY_VOICE: "",
  RENDER_EXTERNAL_URL: "",
  CRON_RUNNER_ENABLED: "false",
  ADMIN_EMAILS: ADMIN,
  CSM_EMAILS: CSM,
  DEFAULT_CSM_EMAIL: CSM,
  DASHBOARD_EXTRA_ALLOWED_EMAILS: `${STAFF},${CSM}`,
  FRONTEND_URL: "http://localhost:3000",
  ALLOWED_ORIGINS: "http://localhost:3000,http://127.0.0.1:3000",
  PORT: port,
  DB_CACHE: "on",
};
for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);

const started = new Date();
const world = installFakeWorld(started.toISOString());
// The fake clock is fixed; move it with real time so sessions, limits and "today" behave.
let last = performance.now();
setInterval(() => {
  const now = performance.now();
  world.advance(Math.round(now - last));
  last = now;
}, 250);

const data = buildPlaceholderData({ size, seed, now: started, csmEmail: CSM });
let docs = 0;
for (const [collection, list] of [...Object.entries(data.collections), ...Object.entries(data.config)]) {
  for (const d of list) {
    world.put(collection, String(d.id), d);
    docs++;
  }
}

/**
 * A few records that are NOT placeholder data, so "Exclude placeholder data"
 * has something left to show: three members of a second story (another seed),
 * with their ids moved from ph_ to rl_ and the placeholder marks removed.
 */
let real = 0;
if (withReal) {
  const other = buildPlaceholderData({ size: "demo", seed: seed + 4, now: started, csmEmail: ADMIN });
  const members = new Set((other.collections.clients ?? []).slice(0, 3).map((c) => String(c.id)));
  const lawyers = new Set((other.collections.providers ?? []).slice(0, 1).map((p) => String(p.id)));
  const about = (d: Doc) =>
    members.has(String(d.id)) || members.has(String(d.clientId)) || lawyers.has(String(d.id)) || (lawyers.has(String(d.providerId)) && d.clientId === undefined);
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") {
      const out: Doc = {};
      for (const [k, x] of Object.entries(v as Doc)) {
        if (k === "placeholder" || k === "placeholderBatch" || k === "placeholderNoFile") continue;
        out[k] = strip(x);
      }
      return out;
    }
    return typeof v === "string" ? v.replaceAll("ph_", "rl_").replaceAll("@example.com", "@members.ilp.test").replaceAll("PH-", "RL-") : v;
  };
  const skip = new Set(["audit_log", "funnel_events", "leads"]);
  for (const [collection, list] of Object.entries(other.collections)) {
    if (skip.has(collection)) continue;
    for (const d of list) {
      if (!about(d)) continue;
      const doc = strip(d) as Doc;
      world.put(collection, String(doc.id), doc);
      real++;
    }
  }
}

const session = (token: string, email: string) => world.put("dashboard_sessions", token, { email, expiresAt: "2099-01-01T00:00:00Z" });
// Tokens are 16+ characters so signed-in requests use the per-session rate limit, as real ones do.
session("dev-admin-session-0000", ADMIN);
session("dev-staff-session-0000", STAFF);
session("dev-csm-session-000000", CSM);
// More admin sessions for crawlers that load many pages a minute (one per page stays under the limit).
for (let i = 1; i < 40; i++) session(`dev-admin-session-${String(i).padStart(4, "0")}`, ADMIN);
const lawyer = (data.collections.providers ?? [])[0];
if (lawyer) world.put("provider_sessions", "dev-lawyer-session-0000", { email: lawyer.email, providerId: lawyer.id, expiresAt: "2099-01-01T00:00:00Z" });
const member = (data.collections.clients ?? [])[0];
if (member) {
  world.put("client_status_sessions", "dev-member-session-0000", {
    email: member.email,
    projectId: member.id,
    createdAt: started.toISOString(),
    expiresAt: new Date(started.getTime() + 7 * 86_400_000).toISOString(),
  });
}

const { createServer } = await import("../main.ts");
createServer();

console.log(`
devWorld: ${docs} placeholder documents (${size}, seed ${seed})${withReal ? ` + ${real} documents that are not placeholder data` : ""}
API  http://localhost:${port}

Sign in by pasting one line into the browser console on http://localhost:3000, then reload:
  admin   localStorage.setItem("ilp_staff_token", "dev-admin-session-0000")    → /dashboard
  staff   localStorage.setItem("ilp_staff_token", "dev-staff-session-0000")    → /dashboard
  CSM     localStorage.setItem("ilp_csm_token", "dev-csm-session-000000")    → /csm
  lawyer  localStorage.setItem("ilp_lawyer_token", "dev-lawyer-session-0000") → /lawyer
  member  localStorage.setItem("ilp_client_token", "dev-member-session-0000") → /status
`);
