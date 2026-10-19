/**
 * scripts/seedClient.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Idempotent seeder for a single demo client so the /status portal ("Track
 * your matter") can be opened and inspected with real placeholder data.
 *
 * The client doc lives in the `clients` collection with the doc id equal to
 * the email-normalized project id (email with `@`/`.` replaced by `_`), which
 * is exactly what the client-status router resolves at login.
 *
 * Creates a full client doc: identity, stage, charges, quotes, comments,
 * stage ratings, consultations, and documents. Every field carries `seed: true`
 * and the doc is read-then-written so re-running is safe.
 *
 * Run:
 *   deno run --allow-net --allow-env --allow-read --allow-write scripts/seedClient.ts
 */

import { loadSync } from "dotenv/mod.ts";

loadSync({ export: true, allowEmptyValues: true });

import put from "../db/put.ts";
import get from "../db/get.ts";
import { emailToDocId } from "../helper/auth/otp.ts";

const CLIENT_EMAIL = "demo.client@example.com";
const CLIENT_ID = emailToDocId(CLIENT_EMAIL); // demo_client_example_com
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

const CLIENT = {
  name: "Demo",
  surname: "Client",
  email: CLIENT_EMAIL,
  dripEmail: CLIENT_EMAIL,
  legalArea: "immigration",
  legalMatter: "Residency permit renewal",
  jurisdiction: "Costa Rica",
  stage: "legal_review",
  stageEnteredAt: NOW,
  source: "seed",
  assignedProviderId: "prov_luisarmando",

  // ── Charges (client portal "Charges" tab) ────────────────────────────────
  charges: [
    {
      id: "chg_1",
      label: "Legal review retainer",
      date: NOW,
      dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      total: 1500,
      payments: [
        { id: "pay_1", date: NOW, amount: 750, method: "wire", received: true },
      ],
    },
    {
      id: "chg_2",
      label: "Government filing fee",
      date: NOW,
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      total: 300,
      payments: [],
    },
  ],

  // ── Quotes (client portal "Quotes" tab) ──────────────────────────────────
  quotes: [
    {
      id: "quote_demo_1",
      title: "Residency renewal package",
      total: 1800,
      currency: "USD",
      status: "sent_to_client",
      serviceType: "immigration",
      legalArea: "immigration",
      createdAt: NOW,
      sentToClientAt: NOW,
    },
  ],

  // ── Comments (client portal "Comments" tab) ──────────────────────────────
  statusComments: [
    {
      id: "cmt_1",
      author: "Luis Armando Oriens",
      authorType: "staff",
      body: "We received your documents and are reviewing the renewal package.",
      stage: "legal_review",
      createdAt: NOW,
    },
    {
      id: "cmt_2",
      author: CLIENT_EMAIL,
      authorType: "client",
      body: "Thanks! Let me know if you need anything else from my side.",
      stage: "legal_review",
      createdAt: NOW,
    },
  ],

  // ── Stage ratings ────────────────────────────────────────────────────────
  stageRatings: {
    scoping: { rating: 5, note: "Very clear process.", timestamp: NOW, ratedBy: CLIENT_EMAIL },
  },

  // ── Consultations (identity snapshot) ────────────────────────────────────
  consultations: [
    {
      name: "Demo",
      surname: "Client",
      email: CLIENT_EMAIL,
      legalArea: "immigration",
      legalMatter: "Residency permit renewal",
      jurisdiction: "Costa Rica",
      source: "seed",
      timestamp: NOW,
    },
  ],

  // ── Documents (client portal "Documents" tab) ────────────────────────────
  documents: [
    { id: "doc_1", name: "Passport scan", kind: "identity", uploadedAt: NOW },
    { id: "doc_2", name: "DIMEX card", kind: "identity", uploadedAt: NOW },
  ],

  // ── Activity / audit ─────────────────────────────────────────────────────
  notes: [
    { id: "note_1", body: "Seeded demo client.", author: "seed", createdAt: NOW },
  ],
  activityLog: [
    { type: "seeded", actor: "seed", timestamp: NOW },
  ],

  createdAt: NOW,
  updatedAt: NOW,
  seed: true,
};

async function run() {
  const status = await seedIfMissing("clients", CLIENT_ID, CLIENT);

  console.log("\n===== SEED CLIENT RESULTS =====");
  console.log(`  clients/${CLIENT_ID} (${status})`);
  console.log("\nClient login (Track your matter):");
  console.log(`  email:     ${CLIENT_EMAIL}`);
  console.log(`  projectId: ${CLIENT_ID}`);
  console.log("\nOpen /status, enter the email above, and the OTP will be sent");
  console.log("to that address (readable from the SMTP sent folder).");
}

run().catch((err) => {
  console.error("Seed failed:", err instanceof Error ? err.message : err);
  Deno.exit(1);
});