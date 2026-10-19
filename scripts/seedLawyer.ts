/**
 * scripts/seedLawyer.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Idempotent seeder for a single demo lawyer (provider) so the /lawyer portal
 * can be opened and inspected with real placeholder data.
 *
 * Creates:
 *   1. A `providers` doc (the lawyer identity, resolved by email at login).
 *   2. A `provider_sessions` doc (a valid login token, printed at the end).
 *   3. Several `clients` assigned to this lawyer (Kanban board).
 *   4. `quoteSettlements` rows with provider payments (finance tab).
 *
 * Every doc is read-then-written (skipped when it already exists) so re-running
 * is safe. All placeholder docs carry `seed: true`.
 *
 * Run:
 *   deno run --allow-net --allow-env --allow-read --allow-write scripts/seedLawyer.ts
 */

import { loadSync } from "dotenv/mod.ts";

loadSync({ export: true, allowEmptyValues: true });

import put from "../db/put.ts";
import get from "../db/get.ts";
import { generateSessionToken } from "../helper/auth/otp.ts";

const LAWYER_EMAIL = "luisarmando@internationalrelocationpartner.com";
const LAWYER_ID = "prov_luisarmando";
const NOW = new Date().toISOString();

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

// ── 1. Lawyer identity ────────────────────────────────────────────────────────
const PROVIDER = {
  id: LAWYER_ID,
  name: "Luis Armando Oriens",
  email: LAWYER_EMAIL,
  phone: "+506 7108 6045",
  legalAreas: ["immigration", "corporate", "real_estate"],
  jurisdictions: ["Costa Rica", "Panama"],
  languages: ["es", "en"],
  active: true,
  status: "active",
  score: 4.8,
  vettedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  seed: true,
};

// ── 2. Assigned clients (Kanban board) ────────────────────────────────────────
const CLIENTS: Array<Record<string, unknown>> = [
  {
    id: "seed_lawyer_client_1",
    name: "Valeria",
    surname: "Castro",
    email: "valeria.castro@example.com",
    legalArea: "immigration",
    legalMatter: "Residency renewal",
    jurisdiction: "Costa Rica",
    stage: "intake",
    assignedProviderId: LAWYER_ID,
    stageEnteredAt: NOW,
    source: "seed",
    notes: [{ id: "n1", body: "Needs DIMEX renewal before March.", author: LAWYER_EMAIL, createdAt: NOW }],
    activityLog: [{ type: "seeded", actor: LAWYER_EMAIL, timestamp: NOW }],
    consultations: [{ name: "Valeria", surname: "Castro", email: "valeria.castro@example.com", legalArea: "immigration", jurisdiction: "Costa Rica", createdAt: NOW }],
    createdAt: NOW,
    updatedAt: NOW,
    seed: true,
  },
  {
    id: "seed_lawyer_client_2",
    name: "Andres",
    surname: "Molina",
    email: "andres.molina@example.com",
    legalArea: "corporate",
    legalMatter: "SRL formation",
    jurisdiction: "Panama",
    stage: "scoping",
    assignedProviderId: LAWYER_ID,
    stageEnteredAt: NOW,
    source: "seed",
    notes: [],
    activityLog: [{ type: "seeded", actor: LAWYER_EMAIL, timestamp: NOW }],
    consultations: [{ name: "Andres", surname: "Molina", email: "andres.molina@example.com", legalArea: "corporate", jurisdiction: "Panama", createdAt: NOW }],
    createdAt: NOW,
    updatedAt: NOW,
    seed: true,
  },
  {
    id: "seed_lawyer_client_3",
    name: "Camila",
    surname: "Rojas",
    email: "camila.rojas@example.com",
    legalArea: "real_estate",
    legalMatter: "Property title transfer",
    jurisdiction: "Costa Rica",
    stage: "legal_review",
    assignedProviderId: LAWYER_ID,
    stageEnteredAt: NOW,
    source: "seed",
    notes: [],
    activityLog: [{ type: "seeded", actor: LAWYER_EMAIL, timestamp: NOW }],
    consultations: [{ name: "Camila", surname: "Rojas", email: "camila.rojas@example.com", legalArea: "real_estate", jurisdiction: "Costa Rica", createdAt: NOW }],
    createdAt: NOW,
    updatedAt: NOW,
    seed: true,
  },
  {
    id: "seed_lawyer_client_4",
    name: "Diego",
    surname: "Fernandez",
    email: "diego.fernandez@example.com",
    legalArea: "immigration",
    legalMatter: "Citizenship application",
    jurisdiction: "Spain",
    stage: "quote_sent",
    assignedProviderId: LAWYER_ID,
    stageEnteredAt: NOW,
    source: "seed",
    notes: [],
    activityLog: [{ type: "seeded", actor: LAWYER_EMAIL, timestamp: NOW }],
    consultations: [{ name: "Diego", surname: "Fernandez", email: "diego.fernandez@example.com", legalArea: "immigration", jurisdiction: "Spain", createdAt: NOW }],
    createdAt: NOW,
    updatedAt: NOW,
    seed: true,
  },
];

// ── 3. Finance settlements (provider payments) ────────────────────────────────
const SETTLEMENTS: Array<Record<string, unknown>> = [
  {
    id: "seed_settlement_1",
    clientId: "seed_lawyer_client_1",
    providerPayments: [
      { providerId: LAWYER_ID, amount: 1200, paid: true, date: NOW, note: "Residency renewal fee" },
    ],
    createdAt: NOW,
    seed: true,
  },
  {
    id: "seed_settlement_2",
    clientId: "seed_lawyer_client_2",
    providerPayments: [
      { providerId: LAWYER_ID, amount: 2500, paid: false, date: NOW, note: "SRL formation (pending)" },
    ],
    createdAt: NOW,
    seed: true,
  },
  {
    id: "seed_settlement_3",
    clientId: "seed_lawyer_client_4",
    providerPayments: [
      { providerId: LAWYER_ID, amount: 1800, paid: true, date: NOW, note: "Citizenship application" },
    ],
    createdAt: NOW,
    seed: true,
  },
];

// ── 4. Login session ──────────────────────────────────────────────────────────
const SESSION_TOKEN = generateSessionToken();
const SESSION_EXPIRY = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

// ── Main ──────────────────────────────────────────────────────────────────────
const results: string[] = [];

async function run() {
  const p = await seedIfMissing("providers", LAWYER_ID, PROVIDER);
  results.push(`providers/${LAWYER_ID} (${p})`);

  for (const c of CLIENTS) {
    const s = await seedIfMissing("clients", String(c.id), c);
    results.push(`clients/${c.id} (${s})`);
  }

  for (const s of SETTLEMENTS) {
    const st = await seedIfMissing("quoteSettlements", String(s.id), s);
    results.push(`quoteSettlements/${s.id} (${st})`);
  }

  const sess = await seedIfMissing("provider_sessions", SESSION_TOKEN, {
    email: LAWYER_EMAIL,
    providerId: LAWYER_ID,
    createdAt: NOW,
    expiresAt: SESSION_EXPIRY,
    seed: true,
  });
  results.push(`provider_sessions (${sess})`);

  console.log("\n===== SEED LAWYER RESULTS =====");
  for (const r of results) console.log(`  ${r}`);
  console.log("\nLawyer login:");
  console.log(`  email: ${LAWYER_EMAIL}`);
  console.log(`  providerId: ${LAWYER_ID}`);
  console.log("\nProvider session token (paste into localStorage `ilp_provider_token`):");
  console.log(`  ${SESSION_TOKEN}`);
  console.log(`Session expires: ${SESSION_EXPIRY}`);
}

run().catch((err) => {
  console.error("Seed failed:", err instanceof Error ? err.message : err);
  Deno.exit(1);
});