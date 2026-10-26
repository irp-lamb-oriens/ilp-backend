/**
 * scripts/seedAdminClient.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Idempotent, non-destructive filler for the demo admin client:
 *
 *   projectId: admin_internationallegalpartner_com
 *   email:     admin@internationallegalpartner.com
 *
 * The client-status portal reads the three editable matter fields
 * (legalArea, legalMatter, jurisdiction) from the latest `consultations`
 * entry first, then falls back to the root doc. This script fills both so the
 * "Your details" section renders real values instead of "—", and seeds a
 * Panama deadline set so the deadlines tab has data.
 *
 * It reads the existing doc and PATCHes only the matter fields, so any other
 * data already on the doc (charges, quotes, comments, ratings) is preserved.
 *
 * Run:
 *   deno run --allow-net --allow-env --allow-read --allow-write scripts/seedAdminClient.ts
 */

import { loadSync } from "dotenv/mod.ts";

loadSync({ export: true, allowEmptyValues: true });

import get from "../db/get.ts";
import patch from "../db/patch.ts";
import { emailToDocId } from "../helper/auth/otp.ts";

const ADMIN_EMAIL = "admin@internationallegalpartner.com";
const ADMIN_ID = emailToDocId(ADMIN_EMAIL); // admin_internationallegalpartner_com

const NOW = new Date().toISOString();
const DAY = 24 * 60 * 60 * 1000;

/** YYYY-MM-DD for a date n days from now (deadline dates are calendar days). */
function dateAhead(n: number): string {
  return new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
}

// ── Matter values (must match the field registry enums + country catalog) ──
const LEGAL_AREA = "corporate";
const LEGAL_MATTER = "business";
const JURISDICTION = "Panama";

// ── Panama deadlines (priority ids from countryCatalog.ts) ──────────────────
const DEADLINES: Record<string, unknown> = {
  PA_CORPORATE_TASA: {
    priorityId: "PA_CORPORATE_TASA",
    date: dateAhead(45),
    note: "Annual franchise tax (tasa única)",
    updatedAt: NOW,
  },
  PA_AGENT_RECORDS: {
    priorityId: "PA_AGENT_RECORDS",
    date: dateAhead(30),
    note: "Registered agent records delivery",
    updatedAt: NOW,
  },
  PA_RESIDENCY_RENEWAL: {
    priorityId: "PA_RESIDENCY_RENEWAL",
    date: dateAhead(120),
    note: "Residency card renewal",
    updatedAt: NOW,
  },
  PA_PROPERTY_TAX: {
    priorityId: "PA_PROPERTY_TAX",
    date: dateAhead(60),
    note: "Property tax installment",
    updatedAt: NOW,
  },
};

async function run() {
  const existing = await get("clients", ADMIN_ID).catch(() => null);
  if (!existing) {
    console.error(
      `Client doc clients/${ADMIN_ID} does not exist. Run seedPabloAndAdmin.ts first.`,
    );
    Deno.exit(1);
  }

  // Preserve any existing consultations, appending a fresh snapshot so the
  // latest entry carries the matter fields the portal reads.
  const consultations = Array.isArray(existing.consultations)
    ? [...(existing.consultations as Record<string, unknown>[])]
    : [];
  consultations.push({
    name: (existing.name as string) || "Admin",
    surname: (existing.surname as string) || "Account",
    email: ADMIN_EMAIL,
    legalArea: LEGAL_AREA,
    legalMatter: LEGAL_MATTER,
    jurisdiction: JURISDICTION,
    source: "seed_admin_client",
    timestamp: NOW,
  });

  await patch("clients", ADMIN_ID, {
    legalArea: LEGAL_AREA,
    legalMatter: LEGAL_MATTER,
    jurisdiction: JURISDICTION,
    consultations,
    deadlines: DEADLINES,
    updatedAt: NOW,
  });

  console.log("\n===== SEED ADMIN CLIENT RESULTS =====");
  console.log(`  clients/${ADMIN_ID} (updated)`);
  console.log(`  legalArea:    ${LEGAL_AREA}`);
  console.log(`  legalMatter:  ${LEGAL_MATTER}`);
  console.log(`  jurisdiction: ${JURISDICTION}`);
  console.log(`  deadlines:    ${Object.keys(DEADLINES).length} Panama priorities`);
  console.log("\nClient login (/status):");
  console.log(`  email:     ${ADMIN_EMAIL}`);
  console.log(`  projectId: ${ADMIN_ID}`);
}

run().catch((err) => {
  console.error("Seed failed:", err instanceof Error ? err.message : err);
  Deno.exit(1);
});