/**
 * scripts/seedPabloAndAdmin.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Idempotent seeder for two demo accounts with rich placeholder data:
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
const DAY = 24 * 60 * 60 * 1000;

function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY).toISOString();
}

function daysAhead(n: number): string {
  return new Date(Date.now() + n * DAY).toISOString();
}

async function seed(
  collection: string,
  id: string,
  data: Record<string, unknown>,
): Promise<"created" | "updated"> {
  const existing = await get(collection, id).catch(() => null);
  await put(collection, id, data);
  return existing ? "updated" : "created";
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
  legalAreas: ["corporate", "compliance", "real_estate", "immigration", "tax"],
  jurisdictions: ["Panama", "Costa Rica", "Mexico", "Spain", "Portugal"],
  languages: ["es", "en", "pt"],
  active: true,
  status: "active",
  score: 4.6,
  bio: "Corporate and cross-border structuring lawyer with 12 years of experience across Latin America and Iberia.",
  barNumber: "CR-88412",
  vettedAt: daysAgo(400),
  createdAt: daysAgo(400),
  updatedAt: NOW,
  seed: true,
};

// 10 clients across every stage for a full Kanban board.
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
    stageEnteredAt: daysAgo(2),
    source: "referral",
    notes: [
      { id: "n1", body: "Wants a Panama holding structure for two operating subsidiaries.", author: PABLO_EMAIL, createdAt: daysAgo(2) },
      { id: "n2", body: "Referred by Gabriela Mora.", author: PABLO_EMAIL, createdAt: daysAgo(1) },
    ],
    activityLog: [
      { type: "seeded", actor: PABLO_EMAIL, timestamp: daysAgo(2) },
      { type: "note_added", actor: PABLO_EMAIL, timestamp: daysAgo(1) },
    ],
    consultations: [{ name: "Fernanda", surname: "Quiros", email: "fernanda.quiros@example.com", legalArea: "corporate", jurisdiction: "Panama", createdAt: daysAgo(2) }],
    createdAt: daysAgo(2),
    updatedAt: daysAgo(1),
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
    stageEnteredAt: daysAgo(5),
    source: "website",
    notes: [
      { id: "n1", body: "Needs AML/KYC policy aligned with CNBV requirements.", author: PABLO_EMAIL, createdAt: daysAgo(5) },
    ],
    activityLog: [
      { type: "seeded", actor: PABLO_EMAIL, timestamp: daysAgo(5) },
      { type: "stage_change", from: "intake", to: "scoping", actor: PABLO_EMAIL, timestamp: daysAgo(3) },
    ],
    consultations: [{ name: "Ricardo", surname: "Salas", email: "ricardo.salas@example.com", legalArea: "compliance", jurisdiction: "Mexico", createdAt: daysAgo(5) }],
    createdAt: daysAgo(5),
    updatedAt: daysAgo(3),
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
    stageEnteredAt: daysAgo(9),
    source: "referral",
    notes: [
      { id: "n1", body: "Negotiating a 5-year commercial lease in Escazú.", author: PABLO_EMAIL, createdAt: daysAgo(9) },
      { id: "n2", body: "Landlord counter-offer received, reviewing escalation clause.", author: PABLO_EMAIL, createdAt: daysAgo(4) },
    ],
    activityLog: [
      { type: "seeded", actor: PABLO_EMAIL, timestamp: daysAgo(9) },
      { type: "stage_change", from: "scoping", to: "legal_review", actor: PABLO_EMAIL, timestamp: daysAgo(6) },
    ],
    consultations: [{ name: "Gabriela", surname: "Mora", email: "gabriela.mora@example.com", legalArea: "real_estate", jurisdiction: "Costa Rica", createdAt: daysAgo(9) }],
    createdAt: daysAgo(9),
    updatedAt: daysAgo(4),
    seed: true,
  },
  {
    id: "seed_pablo_client_4",
    name: "Diego",
    surname: "Fernandez",
    email: "diego.fernandez@example.com",
    legalArea: "immigration",
    legalMatter: "Residency by investment",
    jurisdiction: "Spain",
    stage: "quote_sent",
    assignedProviderId: PABLO_ID,
    stageEnteredAt: daysAgo(14),
    source: "website",
    notes: [
      { id: "n1", body: "Golden visa application, needs property + investment structure.", author: PABLO_EMAIL, createdAt: daysAgo(14) },
    ],
    activityLog: [
      { type: "seeded", actor: PABLO_EMAIL, timestamp: daysAgo(14) },
      { type: "stage_change", from: "legal_review", to: "quote_sent", actor: PABLO_EMAIL, timestamp: daysAgo(7) },
    ],
    consultations: [{ name: "Diego", surname: "Fernandez", email: "diego.fernandez@example.com", legalArea: "immigration", jurisdiction: "Spain", createdAt: daysAgo(14) }],
    createdAt: daysAgo(14),
    updatedAt: daysAgo(7),
    seed: true,
  },
  {
    id: "seed_pablo_client_5",
    name: "Valentina",
    surname: "Rojas",
    email: "valentina.rojas@example.com",
    legalArea: "tax",
    legalMatter: "Transfer pricing study",
    jurisdiction: "Panama",
    stage: "quote_accepted",
    assignedProviderId: PABLO_ID,
    stageEnteredAt: daysAgo(20),
    source: "referral",
    notes: [
      { id: "n1", body: "Accepted quote for transfer pricing documentation.", author: PABLO_EMAIL, createdAt: daysAgo(20) },
    ],
    activityLog: [
      { type: "seeded", actor: PABLO_EMAIL, timestamp: daysAgo(20) },
      { type: "stage_change", from: "quote_sent", to: "quote_accepted", actor: PABLO_EMAIL, timestamp: daysAgo(12) },
    ],
    consultations: [{ name: "Valentina", surname: "Rojas", email: "valentina.rojas@example.com", legalArea: "tax", jurisdiction: "Panama", createdAt: daysAgo(20) }],
    createdAt: daysAgo(20),
    updatedAt: daysAgo(12),
    seed: true,
  },
  {
    id: "seed_pablo_client_6",
    name: "Andres",
    surname: "Molina",
    email: "andres.molina@example.com",
    legalArea: "corporate",
    legalMatter: "SRL formation",
    jurisdiction: "Panama",
    stage: "filing_started",
    assignedProviderId: PABLO_ID,
    stageEnteredAt: daysAgo(25),
    source: "website",
    notes: [
      { id: "n1", body: "SRL formation filed with Registro Público.", author: PABLO_EMAIL, createdAt: daysAgo(25) },
    ],
    activityLog: [
      { type: "seeded", actor: PABLO_EMAIL, timestamp: daysAgo(25) },
      { type: "stage_change", from: "quote_accepted", to: "filing_started", actor: PABLO_EMAIL, timestamp: daysAgo(18) },
    ],
    consultations: [{ name: "Andres", surname: "Molina", email: "andres.molina@example.com", legalArea: "corporate", jurisdiction: "Panama", createdAt: daysAgo(25) }],
    createdAt: daysAgo(25),
    updatedAt: daysAgo(18),
    seed: true,
  },
  {
    id: "seed_pablo_client_7",
    name: "Camila",
    surname: "Rojas",
    email: "camila.rojas@example.com",
    legalArea: "real_estate",
    legalMatter: "Property title transfer",
    jurisdiction: "Costa Rica",
    stage: "filing_started",
    assignedProviderId: PABLO_ID,
    stageEnteredAt: daysAgo(30),
    source: "referral",
    notes: [
      { id: "n1", body: "Title transfer in progress at Registro Nacional.", author: PABLO_EMAIL, createdAt: daysAgo(30) },
    ],
    activityLog: [
      { type: "seeded", actor: PABLO_EMAIL, timestamp: daysAgo(30) },
      { type: "stage_change", from: "quote_accepted", to: "filing_started", actor: PABLO_EMAIL, timestamp: daysAgo(22) },
    ],
    consultations: [{ name: "Camila", surname: "Rojas", email: "camila.rojas@example.com", legalArea: "real_estate", jurisdiction: "Costa Rica", createdAt: daysAgo(30) }],
    createdAt: daysAgo(30),
    updatedAt: daysAgo(22),
    seed: true,
  },
  {
    id: "seed_pablo_client_8",
    name: "Sofia",
    surname: "Mendez",
    email: "sofia.mendez@example.com",
    legalArea: "compliance",
    legalMatter: "Data protection audit",
    jurisdiction: "Portugal",
    stage: "matter_closed",
    assignedProviderId: PABLO_ID,
    stageEnteredAt: daysAgo(45),
    source: "website",
    notes: [
      { id: "n1", body: "GDPR audit completed and delivered.", author: PABLO_EMAIL, createdAt: daysAgo(45) },
    ],
    activityLog: [
      { type: "seeded", actor: PABLO_EMAIL, timestamp: daysAgo(45) },
      { type: "stage_change", from: "filing_started", to: "matter_closed", actor: PABLO_EMAIL, timestamp: daysAgo(10) },
    ],
    consultations: [{ name: "Sofia", surname: "Mendez", email: "sofia.mendez@example.com", legalArea: "compliance", jurisdiction: "Portugal", createdAt: daysAgo(45) }],
    createdAt: daysAgo(45),
    updatedAt: daysAgo(10),
    seed: true,
  },
  {
    id: "seed_pablo_client_9",
    name: "Javier",
    surname: "Castro",
    email: "javier.castro@example.com",
    legalArea: "immigration",
    legalMatter: "Work permit renewal",
    jurisdiction: "Mexico",
    stage: "matter_closed",
    assignedProviderId: PABLO_ID,
    stageEnteredAt: daysAgo(60),
    source: "referral",
    notes: [
      { id: "n1", body: "Work permit renewed for 2 years.", author: PABLO_EMAIL, createdAt: daysAgo(60) },
    ],
    activityLog: [
      { type: "seeded", actor: PABLO_EMAIL, timestamp: daysAgo(60) },
      { type: "stage_change", from: "filing_started", to: "matter_closed", actor: PABLO_EMAIL, timestamp: daysAgo(15) },
    ],
    consultations: [{ name: "Javier", surname: "Castro", email: "javier.castro@example.com", legalArea: "immigration", jurisdiction: "Mexico", createdAt: daysAgo(60) }],
    createdAt: daysAgo(60),
    updatedAt: daysAgo(15),
    seed: true,
  },
  {
    id: "seed_pablo_client_10",
    name: "Lucia",
    surname: "Navarro",
    email: "lucia.navarro@example.com",
    legalArea: "tax",
    legalMatter: "Expat tax planning",
    jurisdiction: "Spain",
    stage: "scoping",
    assignedProviderId: PABLO_ID,
    stageEnteredAt: daysAgo(3),
    source: "website",
    notes: [
      { id: "n1", body: "Relocating to Spain, needs Beckham Law analysis.", author: PABLO_EMAIL, createdAt: daysAgo(3) },
    ],
    activityLog: [
      { type: "seeded", actor: PABLO_EMAIL, timestamp: daysAgo(3) },
    ],
    consultations: [{ name: "Lucia", surname: "Navarro", email: "lucia.navarro@example.com", legalArea: "tax", jurisdiction: "Spain", createdAt: daysAgo(3) }],
    createdAt: daysAgo(3),
    updatedAt: daysAgo(3),
    seed: true,
  },
];

// 8 settlements with a mix of paid/pending for a full finance ledger.
const PABLO_SETTLEMENTS: Array<Record<string, unknown>> = [
  {
    id: "seed_pablo_settlement_1",
    clientId: "seed_pablo_client_1",
    providerPayments: [
      { providerId: PABLO_ID, amount: 2000, paid: true, date: daysAgo(1), note: "Holding company setup" },
    ],
    createdAt: daysAgo(1),
    seed: true,
  },
  {
    id: "seed_pablo_settlement_2",
    clientId: "seed_pablo_client_2",
    providerPayments: [
      { providerId: PABLO_ID, amount: 1500, paid: false, date: daysAgo(3), note: "AML review (pending)" },
    ],
    createdAt: daysAgo(3),
    seed: true,
  },
  {
    id: "seed_pablo_settlement_3",
    clientId: "seed_pablo_client_3",
    providerPayments: [
      { providerId: PABLO_ID, amount: 1800, paid: true, date: daysAgo(4), note: "Commercial lease review" },
    ],
    createdAt: daysAgo(4),
    seed: true,
  },
  {
    id: "seed_pablo_settlement_4",
    clientId: "seed_pablo_client_4",
    providerPayments: [
      { providerId: PABLO_ID, amount: 3500, paid: false, date: daysAgo(7), note: "Golden visa package (pending)" },
    ],
    createdAt: daysAgo(7),
    seed: true,
  },
  {
    id: "seed_pablo_settlement_5",
    clientId: "seed_pablo_client_5",
    providerPayments: [
      { providerId: PABLO_ID, amount: 2200, paid: true, date: daysAgo(12), note: "Transfer pricing study" },
    ],
    createdAt: daysAgo(12),
    seed: true,
  },
  {
    id: "seed_pablo_settlement_6",
    clientId: "seed_pablo_client_6",
    providerPayments: [
      { providerId: PABLO_ID, amount: 1200, paid: true, date: daysAgo(18), note: "SRL formation" },
    ],
    createdAt: daysAgo(18),
    seed: true,
  },
  {
    id: "seed_pablo_settlement_7",
    clientId: "seed_pablo_client_8",
    providerPayments: [
      { providerId: PABLO_ID, amount: 2800, paid: true, date: daysAgo(10), note: "GDPR audit" },
    ],
    createdAt: daysAgo(10),
    seed: true,
  },
  {
    id: "seed_pablo_settlement_8",
    clientId: "seed_pablo_client_9",
    providerPayments: [
      { providerId: PABLO_ID, amount: 900, paid: true, date: daysAgo(15), note: "Work permit renewal" },
    ],
    createdAt: daysAgo(15),
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
  stageEnteredAt: daysAgo(6),
  source: "seed",
  assignedProviderId: PABLO_ID,

  charges: [
    {
      id: "chg_1",
      label: "Corporate structuring retainer",
      date: daysAgo(6),
      dueDate: daysAhead(8),
      total: 3000,
      payments: [
        { id: "pay_1", date: daysAgo(5), amount: 1500, method: "wire", received: true },
      ],
    },
    {
      id: "chg_2",
      label: "Notary and registration fees",
      date: daysAgo(6),
      dueDate: daysAhead(24),
      total: 500,
      payments: [],
    },
    {
      id: "chg_3",
      label: "Registered agent annual fee",
      date: daysAgo(6),
      dueDate: daysAhead(60),
      total: 350,
      payments: [],
    },
  ],

  quotes: [
    {
      id: "quote_admin_1",
      title: "Subsidiary registration package",
      total: 3500,
      currency: "USD",
      status: "received",
      serviceType: "corporate",
      legalArea: "corporate",
      createdAt: daysAgo(6),
      sentToClientAt: daysAgo(6),
    },
    {
      id: "quote_admin_2",
      title: "Annual compliance retainer",
      total: 1200,
      currency: "USD",
      status: "received",
      serviceType: "compliance",
      legalArea: "compliance",
      createdAt: daysAgo(2),
    },
  ],

  statusComments: [
    {
      id: "cmt_1",
      author: "Pablo Oriens",
      authorType: "staff",
      body: "Your subsidiary registration package is ready for review.",
      stage: "quote_sent",
      createdAt: daysAgo(6),
    },
    {
      id: "cmt_2",
      author: ADMIN_EMAIL,
      authorType: "client",
      body: "Looks good, I'll review the quote this week.",
      stage: "quote_sent",
      createdAt: daysAgo(5),
    },
    {
      id: "cmt_3",
      author: "Pablo Oriens",
      authorType: "staff",
      body: "I've also drafted an annual compliance retainer for your review.",
      stage: "quote_sent",
      createdAt: daysAgo(2),
    },
    {
      id: "cmt_4",
      author: ADMIN_EMAIL,
      authorType: "client",
      body: "Thanks, I'll compare both options.",
      stage: "quote_sent",
      createdAt: daysAgo(1),
    },
  ],

  stageRatings: {
    scoping: { rating: 4, note: "Thorough and responsive.", timestamp: daysAgo(10), ratedBy: ADMIN_EMAIL },
    legal_review: { rating: 5, note: "Very clear explanations of the structure.", timestamp: daysAgo(6), ratedBy: ADMIN_EMAIL },
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
      timestamp: daysAgo(12),
    },
    {
      name: "Admin",
      surname: "Account",
      email: ADMIN_EMAIL,
      legalArea: "compliance",
      legalMatter: "Annual compliance retainer",
      jurisdiction: "Panama",
      source: "follow_up",
      timestamp: daysAgo(2),
    },
  ],

  documents: [
    { id: "doc_1", name: "Articles of incorporation", kind: "corporate", uploadedAt: daysAgo(6) },
    { id: "doc_2", name: "Shareholder agreement", kind: "corporate", uploadedAt: daysAgo(6) },
    { id: "doc_3", name: "Power of attorney", kind: "corporate", uploadedAt: daysAgo(4) },
    { id: "doc_4", name: "KYC questionnaire", kind: "compliance", uploadedAt: daysAgo(3) },
  ],

  notes: [
    { id: "note_1", body: "Seeded admin client.", author: "seed", createdAt: daysAgo(12) },
    { id: "note_2", body: "Client prefers email over phone for updates.", author: PABLO_EMAIL, createdAt: daysAgo(6) },
  ],
  activityLog: [
    { type: "seeded", actor: "seed", timestamp: daysAgo(12) },
    { type: "stage_change", from: "scoping", to: "legal_review", actor: PABLO_EMAIL, timestamp: daysAgo(8) },
    { type: "stage_change", from: "legal_review", to: "quote_sent", actor: PABLO_EMAIL, timestamp: daysAgo(6) },
  ],

  createdAt: daysAgo(12),
  updatedAt: daysAgo(1),
  seed: true,
};

// ══════════════════════════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════════════════════════
const results: string[] = [];

async function run() {
  // Pablo provider
  const p = await seed("providers", PABLO_ID, PABLO_PROVIDER);
  results.push(`providers/${PABLO_ID} (${p})`);

  for (const c of PABLO_CLIENTS) {
    const s = await seed("clients", String(c.id), c);
    results.push(`clients/${c.id} (${s})`);
  }

  for (const s of PABLO_SETTLEMENTS) {
    const st = await seed("quoteSettlements", String(s.id), s);
    results.push(`quoteSettlements/${s.id} (${st})`);
  }

  // Admin client
  const a = await seed("clients", ADMIN_ID, ADMIN_CLIENT);
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