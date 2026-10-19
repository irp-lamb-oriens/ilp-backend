/**
 * scripts/seedPabloAndAdmin.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Idempotent seeder for two demo accounts:
 *   1. Pablo (lawyer)  — pablo@internationalrelocationpartner.com
 *   2. Admin (client)  — admin@internationallegalpartner.com
 *
 * Each is read-then-written (skipped when it already exists) so re-running is
 * safe. All placeholder docs carry `seed: true`.
 *
 * Run:
 *   deno run --allow-net --allow-env --allow-read --allow-write scripts/seedPabloAndAdmin.ts
 */

import { loadSync } from "dotenv/mod.ts";

loadSync({ export: true, allowEmptyValues: true });

import put from "../db/put.ts";
import get from "../db/get.ts";
import { emailToDocId } from "../helper/auth/otp.ts";

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

// ══════════════════════════════════════════════════════════════════════════
// 1. PABLO — lawyer (provider)
// ══════════════════════════════════════════════════════════════════════════
const PABLO_EMAIL = "pablo@internationalrelocationpartner.com";
const PABLO_ID = "prov_pablo";

const PABLO_PROVIDER = {
  id: PABLO_ID,
  name: "Pablo Oriens",
  email: PABLO_EMAIL,
  phone: "+506 7108 6045",
  legalAreas: ["corporate", "compliance", "real_estate"],
  jurisdictions: ["Panama", "Costa Rica", "Mexico"],
  languages: ["es", "en"],
  active: true,
  status: "active",
  score: 4.6,
  vettedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  seed: true,
};

const PABLO_CLIENTS: Array<Record<string, unknown>> = [
  {
    id: "seed_pablo_client_1",
    name: "Fernanda",
    surname: "Quiros",
    email: "fernanda.quiros@example.com",
    legalArea: "corporate",
    legalMatter: "Holding company setup",
    jurisdiction: "Panama",
    stage: "intake",
    assignedProviderId: PABLO_ID,
    stageEnteredAt: NOW,
    source: "seed",
    notes: [{ id: "n1", body: "Wants a Panama holding structure.", author: PABLO_EMAIL, createdAt: NOW }],
    activityLog: [{ type: "seeded", actor: PABLO_EMAIL, timestamp: NOW }],
    consultations: [{ name: "Fernanda", surname: "Quiros", email: "fernanda.quiros@example.com", legalArea: "corporate", jurisdiction: "Panama", createdAt: NOW }],
    createdAt: NOW,
    updatedAt: NOW,
    seed: true,
  },
  {
    id: "seed_pablo_client_2",
    name: "Ricardo",
    surname: "Salas",
    email: "ricardo.salas@example.com",
    legalArea: "compliance",
    legalMatter: "AML policy review",
    jurisdiction: "Mexico",
    stage: "scoping",
    assignedProviderId: PABLO_ID,
    stageEnteredAt: NOW,
    source: "seed",
    notes: [],
    activityLog: [{ type: "seeded", actor: PABLO_EMAIL, timestamp: NOW }],
    consultations: [{ name: "Ricardo", surname: "Salas", email: "ricardo.salas@example.com", legalArea: "compliance", jurisdiction: "Mexico", createdAt: NOW }],
    createdAt: NOW,
    updatedAt: NOW,
    seed: true,
  },
  {
    id: "seed_pablo_client_3",
    name: "Gabriela",
    surname: "Mora",
    email: "gabriela.mora@example.com",
    legalArea: "real_estate",
    legalMatter: "Commercial lease",
    jurisdiction: "Costa Rica",
    stage: "legal_review",
    assignedProviderId: PABLO_ID,
    stageEnteredAt: NOW,
    source: "seed",
    notes: [],
    activityLog: [{ type: "seeded", actor: PABLO_EMAIL, timestamp: NOW }],
    consultations: [{ name: "Gabriela", surname: "Mora", email: "gabriela.mora@example.com", legalArea: "real_estate", jurisdiction: "Costa Rica", createdAt: NOW }],
    createdAt: NOW,
    updatedAt: NOW,
    seed: true,
  },
];

const PABLO_SETTLEMENTS: Array<Record<string, unknown>> = [
  {
    id: "seed_pablo_settlement_1",
    clientId: "seed_pablo_client_1",
    providerPayments: [
      { providerId: PABLO_ID, amount: 2000, paid: true, date: NOW, note: "Holding company setup" },
    ],
    createdAt: NOW,
    seed: true,
  },
  {
    id: "seed_pablo_settlement_2",
    clientId: "seed_pablo_client_2",
    providerPayments: [
      { providerId: PABLO_ID, amount: 1500, paid: false, date: NOW, note: "AML review (pending)" },
    ],
    createdAt: NOW,
    seed: true,
  },
];

// ══════════════════════════════════════════════════════════════════════════
// 2. ADMIN — client
// ══════════════════════════════════════════════════════════════════════════
const ADMIN_EMAIL = "admin@internationallegalpartner.com";
const ADMIN_ID = emailToDocId(ADMIN_EMAIL); // admin_internationallegalpartner_com

const ADMIN_CLIENT = {
  name: "Admin",
  surname: "Account",
  email: ADMIN_EMAIL,
  dripEmail: ADMIN_EMAIL,
  legalArea: "corporate",
  legalMatter: "Subsidiary registration",
  jurisdiction: "Panama",
  stage: "quote_sent",
  stageEnteredAt: NOW,
  source: "seed",
  assignedProviderId: PABLO_ID,

  charges: [
    {
      id: "chg_1",
      label: "Corporate structuring retainer",
      date: NOW,
      dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      total: 3000,
      payments: [
        { id: "pay_1", date: NOW, amount: 1500, method: "wire", received: true },
      ],
    },
    {
      id: "chg_2",
      label: "Notary and registration fees",
      date: NOW,
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      total: 500,
      payments: [],
    },
  ],

  quotes: [
    {
      id: "quote_admin_1",
      title: "Subsidiary registration package",
      total: 3500,
      currency: "USD",
      status: "sent_to_client",
      serviceType: "corporate",
      legalArea: "corporate",
      createdAt: NOW,
      sentToClientAt: NOW,
    },
  ],

  statusComments: [
    {
      id: "cmt_1",
      author: "Pablo Oriens",
      authorType: "staff",
      body: "Your subsidiary registration package is ready for review.",
      stage: "quote_sent",
      createdAt: NOW,
    },
    {
      id: "cmt_2",
      author: ADMIN_EMAIL,
      authorType: "client",
      body: "Looks good, I'll review the quote this week.",
      stage: "quote_sent",
      createdAt: NOW,
    },
  ],

  stageRatings: {
    scoping: { rating: 4, note: "Thorough and responsive.", timestamp: NOW, ratedBy: ADMIN_EMAIL },
  },

  consultations: [
    {
      name: "Admin",
      surname: "Account",
      email: ADMIN_EMAIL,
      legalArea: "corporate",
      legalMatter: "Subsidiary registration",
      jurisdiction: "Panama",
      source: "seed",
      timestamp: NOW,
    },
  ],

  documents: [
    { id: "doc_1", name: "Articles of incorporation", kind: "corporate", uploadedAt: NOW },
    { id: "doc_2", name: "Shareholder agreement", kind: "corporate", uploadedAt: NOW },
  ],

  notes: [
    { id: "note_1", body: "Seeded admin client.", author: "seed", createdAt: NOW },
  ],
  activityLog: [
    { type: "seeded", actor: "seed", timestamp: NOW },
  ],

  createdAt: NOW,
  updatedAt: NOW,
  seed: true,
};

// ══════════════════════════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════════════════════════
const results: string[] = [];

async function run() {
  // Pablo provider
  const p = await seedIfMissing("providers", PABLO_ID, PABLO_PROVIDER);
  results.push(`providers/${PABLO_ID} (${p})`);

  for (const c of PABLO_CLIENTS) {
    const s = await seedIfMissing("clients", String(c.id), c);
    results.push(`clients/${c.id} (${s})`);
  }

  for (const s of PABLO_SETTLEMENTS) {
    const st = await seedIfMissing("quoteSettlements", String(s.id), s);
    results.push(`quoteSettlements/${s.id} (${st})`);
  }

  // Admin client
  const a = await seedIfMissing("clients", ADMIN_ID, ADMIN_CLIENT);
  results.push(`clients/${ADMIN_ID} (${a})`);

  console.log("\n===== SEED PABLO + ADMIN RESULTS =====");
  for (const r of results) console.log(`  ${r}`);

  console.log("\nLawyer login (/lawyer):");
  console.log(`  email: ${PABLO_EMAIL}`);
  console.log(`  providerId: ${PABLO_ID}`);

  console.log("\nClient login (/status):");
  console.log(`  email:     ${ADMIN_EMAIL}`);
  console.log(`  projectId: ${ADMIN_ID}`);
}

run().catch((err) => {
  console.error("Seed failed:", err instanceof Error ? err.message : err);
  Deno.exit(1);
});