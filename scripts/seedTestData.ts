/**
 * scripts/seedTestData.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Idempotent test-data seeder for the ILP dashboard.
 *
 * Seeds placeholder documents across every collection the dashboard reads,
 * plus a valid dashboard session for info@internationallegalpartner.com so the
 * staff login works without going through the OTP email round-trip.
 *
 * Every seeded doc is read-then-written (skipped when it already exists) so
 * re-running is safe and never clobbers operator edits. All placeholder docs
 * carry `seed: true` and a `seed-` prefixed id so they can be swept later.
 *
 * Run:
 *   deno run --allow-net --allow-env --allow-read --allow-write scripts/seedTestData.ts
 */

import { loadSync } from "dotenv/mod.ts";

loadSync({ export: true, allowEmptyValues: true });

import put from "../db/put.ts";
import get from "../db/get.ts";
import { generateSessionToken } from "../helper/auth/otp.ts";

const STAFF_EMAIL = "info@internationallegalpartner.com";
const NOW = new Date().toISOString();

/** Write a doc only when it does not already exist (idempotent). */
async function seedIfMissing(
  collection: string,
  id: string,
  data: Record<string, unknown>,
): Promise<"created" | "skipped"> {
  const existing = await get(collection, id).catch(() => null);
  if (existing) return "skipped";
  await put(collection, id, data);
  return "created";
}

// ── 1. Dashboard session (staff login) ────────────────────────────────────────
// The session doc id IS the token. We generate one and print it so the operator
// can paste it into the dashboard (localStorage key `dashboard_token`) or use
// the normal OTP flow. Expires far in the future for a stable test login.
const SESSION_TOKEN = generateSessionToken();
const SESSION_EXPIRY = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

// ── 2. Pipeline stage config (so stage labels resolve) ────────────────────────
const STAGES: Array<Record<string, unknown>> = [
  { id: "intake", label: "Intake", order: 0, active: true, hiddenFromClient: true, phase: "sales", notifyGroup: "sales", isSeed: true },
  { id: "scoping", label: "Scoping", order: 1, active: true, hiddenFromClient: false, phase: "sales", notifyGroup: "sales", isSeed: true },
  { id: "legal_review", label: "Legal Review", order: 2, active: true, hiddenFromClient: false, phase: "legal_work", notifyGroup: "legal", isSeed: true },
  { id: "quote_sent", label: "Quote Sent", order: 3, active: true, hiddenFromClient: false, phase: "sales", notifyGroup: "sales", isSeed: true },
  { id: "quote_accepted", label: "Quote Accepted", order: 4, active: true, hiddenFromClient: false, phase: "sales", notifyGroup: "sales", isSeed: true },
  { id: "filing", label: "Filing", order: 5, active: true, hiddenFromClient: false, phase: "legal_work", notifyGroup: "legal", isSeed: true },
  { id: "closed", label: "Closed", order: 6, active: true, hiddenFromClient: false, phase: "completion", notifyGroup: "ops", isSeed: true },
];

// ── 3. Placeholder clients (drive pipeline + stage satisfaction + finance) ────
interface SeedClient {
  id: string;
  name: string;
  surname: string;
  email: string;
  legalArea: string;
  legalMatter: string;
  jurisdiction: string;
  stage: string;
  rating: number;
  quoteTotal: number;
  quoteCost: number;
  quoteStatus: string;
}

const CLIENTS: SeedClient[] = [
  { id: "seed_maria_garcia_example_com", name: "Maria", surname: "Garcia", email: "maria.garcia@example.com", legalArea: "immigration", legalMatter: "Residency permit", jurisdiction: "Costa Rica", stage: "intake", rating: 4, quoteTotal: 0, quoteCost: 0, quoteStatus: "draft" },
  { id: "seed_john_smith_example_com", name: "John", surname: "Smith", email: "john.smith@example.com", legalArea: "corporate", legalMatter: "Company formation", jurisdiction: "Panama", stage: "scoping", rating: 5, quoteTotal: 0, quoteCost: 0, quoteStatus: "draft" },
  { id: "seed_ana_lopez_example_com", name: "Ana", surname: "Lopez", email: "ana.lopez@example.com", legalArea: "real_estate", legalMatter: "Property title", jurisdiction: "Mexico", stage: "legal_review", rating: 3, quoteTotal: 0, quoteCost: 0, quoteStatus: "draft" },
  { id: "seed_carlos_ruiz_example_com", name: "Carlos", surname: "Ruiz", email: "carlos.ruiz@example.com", legalArea: "immigration", legalMatter: "Citizenship", jurisdiction: "Spain", stage: "quote_sent", rating: 5, quoteTotal: 2500, quoteCost: 1500, quoteStatus: "sent_to_client" },
  { id: "seed_elena_mora_example_com", name: "Elena", surname: "Mora", email: "elena.mora@example.com", legalArea: "corporate", legalMatter: "Contract review", jurisdiction: "Colombia", stage: "quote_accepted", rating: 4, quoteTotal: 4000, quoteCost: 2200, quoteStatus: "client_accepted" },
  { id: "seed_diego_castro_example_com", name: "Diego", surname: "Castro", email: "diego.castro@example.com", legalArea: "notary", legalMatter: "Apostille", jurisdiction: "Portugal", stage: "filing", rating: 5, quoteTotal: 1200, quoteCost: 600, quoteStatus: "client_accepted" },
  { id: "seed_lucia_vega_example_com", name: "Lucia", surname: "Vega", email: "lucia.vega@example.com", legalArea: "family_estate", legalMatter: "Will drafting", jurisdiction: "Costa Rica", stage: "closed", rating: 5, quoteTotal: 1800, quoteCost: 900, quoteStatus: "client_accepted" },
];

// ── 4. Placeholder providers ──────────────────────────────────────────────────
const PROVIDERS: Array<Record<string, unknown>> = [
  { id: "seed_prov_immigration_cr", name: "Lic. Roberto Jimenez", email: "roberto.jimenez@example.com", legalAreas: ["immigration"], jurisdictions: ["Costa Rica"], languages: ["es", "en"], active: true, score: 4.5, createdAt: NOW, createdBy: STAFF_EMAIL },
  { id: "seed_prov_corporate_pa", name: "Dra. Sofia Mendez", email: "sofia.mendez@example.com", legalAreas: ["corporate", "compliance"], jurisdictions: ["Panama"], languages: ["es", "en"], active: true, score: 4, createdAt: NOW, createdBy: STAFF_EMAIL },
  { id: "seed_prov_realestate_mx", name: "Lic. Andres Torres", email: "andres.torres@example.com", legalAreas: ["real_estate", "notary"], jurisdictions: ["Mexico"], languages: ["es"], active: true, score: 3.5, createdAt: NOW, createdBy: STAFF_EMAIL },
];

// ── 5. Placeholder vendors ────────────────────────────────────────────────────
const VENDORS: Array<Record<string, unknown>> = [
  { id: "seed_vendor_legal_translations", companyName: "Legal Translations CR", contactName: "Paula Rojas", email: "paula@legaltranslations.example.com", legalAreas: ["other"], jurisdictions: ["CR"], languages: ["es", "en"], active: true, createdAt: NOW, updatedAt: NOW },
  { id: "seed_vendor_courier_express", companyName: "Courier Express Legal", contactName: "Marco Diaz", email: "marco@courierexpress.example.com", legalAreas: ["other"], jurisdictions: [], languages: ["es"], active: true, createdAt: NOW, updatedAt: NOW },
];

// ── 6. Placeholder profiles / consultations / templates / rules / alerts ──────
const PROFILES: Array<{ id: string; data: Record<string, unknown> }> = [
  { id: "seed_profile_maria", data: { email: "maria.garcia@example.com", name: "Maria Garcia", country: "Costa Rica", createdAt: NOW } },
  { id: "seed_profile_john", data: { email: "john.smith@example.com", name: "John Smith", country: "Panama", createdAt: NOW } },
];

const CONSULTATIONS: Array<{ id: string; data: Record<string, unknown> }> = [
  { id: "seed_consultation_1", data: { name: "Maria", surname: "Garcia", email: "maria.garcia@example.com", legalArea: "immigration", jurisdiction: "Costa Rica", status: "confirmed", createdAt: NOW } },
  { id: "seed_consultation_2", data: { name: "John", surname: "Smith", email: "john.smith@example.com", legalArea: "corporate", jurisdiction: "Panama", status: "confirmed", createdAt: NOW } },
];

const TEMPLATES: Array<{ id: string; data: Record<string, unknown> }> = [
  { id: "seed_template_residency", data: { title: "Residency Application Guide", country: "CR", category: "immigration", status: "published", createdAt: NOW } },
  { id: "seed_template_company", data: { title: "Company Formation Checklist", country: "PA", category: "corporate", status: "published", createdAt: NOW } },
];

const RULES: Array<{ id: string; data: Record<string, unknown> }> = [
  { id: "seed_rule_dimex", data: { title: "DIMEX renewal reminder", country: "CR", category: "immigration", status: "active", createdAt: NOW } },
  { id: "seed_rule_marchamo", data: { title: "Marchamo deadline", country: "CR", category: "property", status: "active", createdAt: NOW } },
];

const ALERTS: Array<{ id: string; data: Record<string, unknown> }> = [
  { id: "seed_alert_1", data: { title: "DIMEX renewal due", country: "CR", category: "immigration", status: "scheduled", createdAt: NOW } },
  { id: "seed_alert_2", data: { title: "Corporate tax filing", country: "PA", category: "corporate", status: "responded", createdAt: NOW } },
];

const UPDATES: Array<{ id: string; data: Record<string, unknown> }> = [
  { id: "seed_update_1", data: { title: "New residency requirements", country: "CR", category: "immigration", status: "published", createdAt: NOW } },
];

const TASKS: Array<{ id: string; data: Record<string, unknown> }> = [
  { id: "seed_task_1", data: { title: "Follow up with Maria", status: "open", createdAt: NOW } },
];

const LEADS: Array<{ id: string; data: Record<string, unknown> }> = [
  { id: "seed_lead_1", data: { name: "Pedro Alvarez", email: "pedro.alvarez@example.com", country: "Costa Rica", createdAt: NOW } },
];

const POSTS: Array<{ id: string; data: Record<string, unknown> }> = [
  { id: "seed_post_1", data: { title: "Guide: Residency in Costa Rica", kind: "guide", slug: "residency-costa-rica", status: "published", createdAt: NOW } },
];

const INVOICES: Array<{ id: string; data: Record<string, unknown> }> = [
  { id: "seed_invoice_1", data: { clientId: "seed_elena_mora_example_com", amount: 4000, currency: "USD", status: "paid", createdAt: NOW } },
];

// ── 7. Config sentinels + service types ───────────────────────────────────────
const SERVICE_TYPES: Array<{ id: string; data: Record<string, unknown> }> = [
  { id: "immigration", data: { label: "Immigration", createdAt: NOW } },
  { id: "corporate", data: { label: "Corporate", createdAt: NOW } },
  { id: "real_estate", data: { label: "Real Estate", createdAt: NOW } },
  { id: "notary", data: { label: "Notary", createdAt: NOW } },
  { id: "family_estate", data: { label: "Family & Estate", createdAt: NOW } },
  { id: "litigation", data: { label: "Litigation", createdAt: NOW } },
  { id: "compliance", data: { label: "Compliance", createdAt: NOW } },
];

// ── Main ──────────────────────────────────────────────────────────────────────

const results: string[] = [];

async function run() {
  // 1. Session
  const sessionStatus = await seedIfMissing("dashboard_sessions", SESSION_TOKEN, {
    email: STAFF_EMAIL,
    createdAt: NOW,
    expiresAt: SESSION_EXPIRY,
    seed: true,
  });
  results.push(`dashboard_sessions (${sessionStatus})`);

  // 2. Stage config
  for (const stage of STAGES) {
    const status = await seedIfMissing("stage_config", String(stage.id), {
      ...stage,
      createdAt: NOW,
      updatedAt: NOW,
    });
    results.push(`stage_config/${stage.id} (${status})`);
  }

  // 3. Clients
  for (const c of CLIENTS) {
    const quotes = c.quoteTotal > 0
      ? [{
          id: `seed_quote_${c.id}`,
          title: `${c.legalMatter} quote`,
          total: c.quoteTotal,
          costSubtotal: c.quoteCost,
          currency: "USD",
          status: c.quoteStatus,
          serviceType: c.legalArea,
          legalArea: c.legalArea,
          createdAt: NOW,
          sentToClientAt: c.quoteStatus !== "draft" ? NOW : null,
          clientAcceptedAt: c.quoteStatus === "client_accepted" ? NOW : null,
        }]
      : [];

    const status = await seedIfMissing("clients", c.id, {
      name: c.name,
      surname: c.surname,
      email: c.email,
      legalArea: c.legalArea,
      legalMatter: c.legalMatter,
      jurisdiction: c.jurisdiction,
      stage: c.stage,
      stageEnteredAt: NOW,
      source: "seed",
      quotes,
      charges: [],
      notes: [{ id: "seed_note", body: "Seeded placeholder note.", author: STAFF_EMAIL, createdAt: NOW }],
      pendingActions: [],
      activityLog: [{ type: "seeded", actor: STAFF_EMAIL, timestamp: NOW }],
      stageRatings: [{ stage: c.stage, rating: c.rating, comment: "Seeded rating.", createdAt: NOW }],
      consultations: [{ name: c.name, surname: c.surname, email: c.email, legalArea: c.legalArea, jurisdiction: c.jurisdiction, createdAt: NOW }],
      createdAt: NOW,
      updatedAt: NOW,
      seed: true,
    });
    results.push(`clients/${c.id} (${status})`);
  }

  // 4. Providers
  for (const p of PROVIDERS) {
    const status = await seedIfMissing("providers", String(p.id), { ...p, seed: true });
    results.push(`providers/${p.id} (${status})`);
  }

  // 5. Vendors
  for (const v of VENDORS) {
    const status = await seedIfMissing("vendors", String(v.id), { ...v, seed: true });
    results.push(`vendors/${v.id} (${status})`);
  }

  // 6. Profiles / consultations / templates / rules / alerts / updates / tasks / leads / posts / invoices
  for (const p of PROFILES) {
    const status = await seedIfMissing("profiles", p.id, { ...p.data, seed: true });
    results.push(`profiles/${p.id} (${status})`);
  }
  for (const c of CONSULTATIONS) {
    const status = await seedIfMissing("consultations", c.id, { ...c.data, seed: true });
    results.push(`consultations/${c.id} (${status})`);
  }
  for (const t of TEMPLATES) {
    const status = await seedIfMissing("templates", t.id, { ...t.data, seed: true });
    results.push(`templates/${t.id} (${status})`);
  }
  for (const r of RULES) {
    const status = await seedIfMissing("rules", r.id, { ...r.data, seed: true });
    results.push(`rules/${r.id} (${status})`);
  }
  for (const a of ALERTS) {
    const status = await seedIfMissing("alerts", a.id, { ...a.data, seed: true });
    results.push(`alerts/${a.id} (${status})`);
  }
  for (const u of UPDATES) {
    const status = await seedIfMissing("updates", u.id, { ...u.data, seed: true });
    results.push(`updates/${u.id} (${status})`);
  }
  for (const t of TASKS) {
    const status = await seedIfMissing("tasks", t.id, { ...t.data, seed: true });
    results.push(`tasks/${t.id} (${status})`);
  }
  for (const l of LEADS) {
    const status = await seedIfMissing("leads", l.id, { ...l.data, seed: true });
    results.push(`leads/${l.id} (${status})`);
  }
  for (const p of POSTS) {
    const status = await seedIfMissing("posts", p.id, { ...p.data, seed: true });
    results.push(`posts/${p.id} (${status})`);
  }
  for (const i of INVOICES) {
    const status = await seedIfMissing("invoices", i.id, { ...i.data, seed: true });
    results.push(`invoices/${i.id} (${status})`);
  }

  // 7. Service types
  for (const s of SERVICE_TYPES) {
    const status = await seedIfMissing("quote_service_types", s.id, { ...s.data, seed: true });
    results.push(`quote_service_types/${s.id} (${status})`);
  }

  // 8. Template downloads (so the funnel's templateDownloads > 0)
  const dlStatus = await seedIfMissing("template_downloads", "seed_download_1", {
    templateId: "seed_template_residency",
    email: "maria.garcia@example.com",
    country: "CR",
    createdAt: NOW,
    seed: true,
  });
  results.push(`template_downloads/seed_download_1 (${dlStatus})`);

  // 9. Audit log entry
  const auditStatus = await seedIfMissing("audit_log", "seed_audit_1", {
    actor: STAFF_EMAIL,
    action: "seed_test_data",
    at: NOW,
    seed: true,
  });
  results.push(`audit_log/seed_audit_1 (${auditStatus})`);

  // ── Report ──────────────────────────────────────────────────────────────────
  console.log("\n===== SEED TEST DATA RESULTS =====");
  for (const r of results) console.log(`  ${r}`);
  console.log("\nStaff session token (paste into dashboard localStorage `dashboard_token`):");
  console.log(`  ${SESSION_TOKEN}`);
  console.log(`Staff email: ${STAFF_EMAIL}`);
  console.log(`Session expires: ${SESSION_EXPIRY}`);
}

run().catch((err) => {
  console.error("Seed failed:", err instanceof Error ? err.message : err);
  Deno.exit(1);
});