/**
 * scripts/seedPlaceholders.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Idempotent placeholder seeder built on the centralized schema system.
 *
 * Every document is produced by a `schemas/placeholders.ts` factory (so the
 * shape always matches the centralized `SchemaMap`), then enriched with
 * realistic demo values. Each doc carries `isPlaceholder: true` so placeholder
 * content is self-identifying and can be swept or filtered later.
 *
 * The core of this seeder is placeholder PEOPLE: a set of clients whose
 * `clients` docs are fully populated for the client status page (comments,
 * stage ratings, charges, quotes, consultations, Lily thread) so a staff
 * member can open `/status/{projectId}` and see a complete, working matter.
 *
 * Project id convention (matches `clientStatusRouter.ts`): the doc id is the
 * email-normalized form (email with `@` and `.` replaced by `_`).
 *
 * Run:
 *   deno run --allow-net --allow-env --allow-read --allow-write scripts/seedPlaceholders.ts
 */

import { loadSync } from "dotenv/mod.ts";

loadSync({ export: true, allowEmptyValues: true });

import get from "../db/get.ts";
import put from "../db/put.ts";
import {
  clientPlaceholder,
  stageConfigPlaceholder,
  quoteServiceTypePlaceholder,
} from "../schemas/placeholders.ts";
import { emailToDocId } from "../helper/auth/otp.ts";

const NOW = new Date().toISOString();
const STAFF_EMAIL = "info@internationallegalpartner.com";

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

// ── Pipeline stage config (so the status page resolves stage labels) ────────
const STAGES: Array<{ id: string; label: string; order: number; hiddenFromClient: boolean }> = [
  { id: "intake", label: "Intake", order: 0, hiddenFromClient: true },
  { id: "scoping", label: "Scoping", order: 1, hiddenFromClient: false },
  { id: "legal_review", label: "Legal Review", order: 2, hiddenFromClient: false },
  { id: "quote_sent", label: "Quote Sent", order: 3, hiddenFromClient: false },
  { id: "quote_accepted", label: "Quote Accepted", order: 4, hiddenFromClient: false },
  { id: "filing", label: "Filing", order: 5, hiddenFromClient: false },
  { id: "closed", label: "Closed", order: 6, hiddenFromClient: false },
];

// ── Service types (so quote service-type labels resolve) ────────────────────
const SERVICE_TYPES = [
  "immigration",
  "corporate",
  "real_estate",
  "notary",
  "family_estate",
  "litigation",
  "compliance",
];

// ── Placeholder people (clients) ────────────────────────────────────────────
interface SeedPerson {
  name: string;
  surname: string;
  email: string;
  legalArea: string;
  legalMatter: string;
  jurisdiction: string;
  stage: string;
  rating: number;
  quoteTotal: number;
  quoteStatus: "received" | "accepted" | "rejected";
  chargeTotal: number;
  chargeReceived: number;
  comment: string;
  lilyQuestion: string;
  lilyAnswer: string;
}

const PEOPLE: SeedPerson[] = [
  {
    name: "Maria",
    surname: "Garcia",
    email: "maria.garcia@example.com",
    legalArea: "immigration",
    legalMatter: "Residency permit",
    jurisdiction: "Costa Rica",
    stage: "scoping",
    rating: 4,
    quoteTotal: 0,
    quoteStatus: "received",
    chargeTotal: 0,
    chargeReceived: 0,
    comment: "Looking forward to getting my residency sorted.",
    lilyQuestion: "What documents do I need for my residency permit?",
    lilyAnswer: "For a Costa Rica residency permit you will typically need a valid passport, a police clearance certificate, and proof of income. Your legal team will confirm the exact list for your case.",
  },
  {
    name: "John",
    surname: "Smith",
    email: "john.smith@example.com",
    legalArea: "corporate",
    legalMatter: "Company formation",
    jurisdiction: "Panama",
    stage: "legal_review",
    rating: 5,
    quoteTotal: 0,
    quoteStatus: "received",
    chargeTotal: 0,
    chargeReceived: 0,
    comment: "Please keep me posted on the incorporation timeline.",
    lilyQuestion: "How long does company formation take in Panama?",
    lilyAnswer: "Company formation in Panama typically takes a few business days once the corporate documents are prepared and notarized. Your legal team will confirm the current timeline.",
  },
  {
    name: "Ana",
    surname: "Lopez",
    email: "ana.lopez@example.com",
    legalArea: "real_estate",
    legalMatter: "Property title",
    jurisdiction: "Mexico",
    stage: "quote_sent",
    rating: 3,
    quoteTotal: 2500,
    quoteStatus: "received",
    chargeTotal: 2500,
    chargeReceived: 0,
    comment: "The quote looks reasonable, reviewing it now.",
    lilyQuestion: "What does the property title process involve?",
    lilyAnswer: "The property title process involves a title search, verification of the seller's ownership, and registration of the transfer. Your legal team will walk you through each step.",
  },
  {
    name: "Carlos",
    surname: "Ruiz",
    email: "carlos.ruiz@example.com",
    legalArea: "immigration",
    legalMatter: "Citizenship",
    jurisdiction: "Spain",
    stage: "quote_accepted",
    rating: 5,
    quoteTotal: 4000,
    quoteStatus: "accepted",
    chargeTotal: 4000,
    chargeReceived: 2000,
    comment: "Accepted the quote, excited to move forward.",
    lilyQuestion: "What happens after I accept the quote?",
    lilyAnswer: "After you accept the quote, your legal team begins preparing the filing and will contact you with the next steps and any documents they need from you.",
  },
  {
    name: "Elena",
    surname: "Mora",
    email: "elena.mora@example.com",
    legalArea: "corporate",
    legalMatter: "Contract review",
    jurisdiction: "Colombia",
    stage: "filing",
    rating: 4,
    quoteTotal: 1200,
    quoteStatus: "accepted",
    chargeTotal: 1200,
    chargeReceived: 1200,
    comment: "Thanks for the quick turnaround on the contract.",
    lilyQuestion: "When will the contract review be complete?",
    lilyAnswer: "Your contract review is in progress. Your legal team will send you the annotated contract and a summary of recommended changes once complete.",
  },
  {
    name: "Diego",
    surname: "Castro",
    email: "diego.castro@example.com",
    legalArea: "notary",
    legalMatter: "Apostille",
    jurisdiction: "Portugal",
    stage: "closed",
    rating: 5,
    quoteTotal: 1800,
    quoteStatus: "accepted",
    chargeTotal: 1800,
    chargeReceived: 1800,
    comment: "Everything is complete, thank you for the help.",
    lilyQuestion: "Is my apostille ready?",
    lilyAnswer: "Your apostille has been completed and your matter is closed. If you need anything else, please reach out to your legal team.",
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────

const results: string[] = [];

async function run() {
  // 1. Stage config
  for (const stage of STAGES) {
    const base = stageConfigPlaceholder(stage.id, stage.id, stage.label, stage.order);
    const status = await seedIfMissing("stage_config", stage.id, {
      ...base,
      description: "",
      icon: "📌",
      color: "#64748b",
      slaDays: null,
      phase: "sales",
      notifyGroup: "sales",
      hiddenFromClient: stage.hiddenFromClient,
      active: true,
      isPlaceholder: true,
    });
    results.push(`stage_config/${stage.id} (${status})`);
  }

  // 2. Service types
  for (const st of SERVICE_TYPES) {
    const base = quoteServiceTypePlaceholder(st, st);
    const status = await seedIfMissing("quote_service_types", st, {
      ...base,
      label: st.charAt(0).toUpperCase() + st.slice(1).replace(/_/g, " "),
      isPlaceholder: true,
    });
    results.push(`quote_service_types/${st} (${status})`);
  }

  // 3. Placeholder people (clients) with full status-page data
  for (const p of PEOPLE) {
    const projectId = emailToDocId(p.email); // email-normalized doc id
    const base = clientPlaceholder(projectId, p.email);

    const quotes = p.quoteTotal > 0
      ? [{
          id: `quote_${projectId}`,
          title: `${p.legalMatter} quote`,
          total: p.quoteTotal,
          currency: "USD",
          status: p.quoteStatus,
          serviceType: p.legalArea,
          legalArea: p.legalArea,
          createdAt: NOW,
          sentToClientAt: NOW,
          clientAcceptedAt: p.quoteStatus === "accepted" ? NOW : null,
        }]
      : [];

    const charges = p.chargeTotal > 0
      ? [{
          id: `charge_${projectId}`,
          label: `${p.legalMatter} — legal fees`,
          date: NOW,
          dueDate: NOW,
          total: p.chargeTotal,
          currency: "USD",
          payments: p.chargeReceived > 0
            ? [{ amount: p.chargeReceived, received: true, date: NOW }]
            : [],
        }]
      : [];

    // Stage ratings are keyed by stage id (matches the status router's
    // `doc.stageRatings ?? {}` object access).
    const stageRatings: Record<string, unknown> = {
      [p.stage]: {
        rating: p.rating,
        note: "Placeholder rating.",
        timestamp: NOW,
        ratedBy: p.email,
      },
    };

    const statusComments = [{
      id: `comment_${projectId}_1`,
      author: p.email,
      authorType: "client",
      body: p.comment,
      createdAt: NOW,
    }];

    const statusChatThread = [
      { role: "user", content: p.lilyQuestion, createdAt: NOW },
      { role: "assistant", content: p.lilyAnswer, createdAt: NOW },
    ];

    const doc = {
      ...base,
      name: p.name,
      surname: p.surname,
      email: p.email,
      legalArea: p.legalArea,
      legalMatter: p.legalMatter,
      jurisdiction: p.jurisdiction,
      stage: p.stage,
      stageEnteredAt: NOW,
      source: "placeholder",
      clientFields: {
        name: p.name,
        surname: p.surname,
        email: p.email,
        legalArea: p.legalArea,
        legalMatter: p.legalMatter,
        jurisdiction: p.jurisdiction,
      },
      consultations: [{
        name: p.name,
        surname: p.surname,
        email: p.email,
        legalArea: p.legalArea,
        legalMatter: p.legalMatter,
        jurisdiction: p.jurisdiction,
        createdAt: NOW,
        updatedAt: NOW,
      }],
      journey: [{ stage: p.stage, enteredAt: NOW }],
      stageRatings,
      charges,
      quotes,
      notes: [{
        id: `note_${projectId}`,
        body: "Placeholder note.",
        author: STAFF_EMAIL,
        createdAt: NOW,
      }],
      pendingActions: [],
      conversations: [],
      statusComments,
      statusChatThread,
      quoteAcceptance: p.quoteStatus === "accepted"
        ? { quoteId: `quote_${projectId}`, acceptedAt: NOW, acceptedBy: p.email }
        : null,
      isPlaceholder: true,
    };

    const status = await seedIfMissing("clients", projectId, doc);
    results.push(`clients/${projectId} (${status})`);
  }

  // ── Report ──────────────────────────────────────────────────────────────────
  console.log("\n===== PLACEHOLDER SEED RESULTS =====");
  for (const r of results) console.log(`  ${r}`);

  console.log("\n===== STATUS PAGE ACCESS (one example) =====");
  const example = PEOPLE[0];
  const exampleProjectId = emailToDocId(example.email);
  console.log(`  Project ID: ${exampleProjectId}`);
  console.log(`  Email:      ${example.email}`);
  console.log(`  URL:        /status/${exampleProjectId}`);
  console.log(`  Stage:      ${example.stage}`);
  console.log(`  Matter:     ${example.legalMatter} (${example.legalArea}, ${example.jurisdiction})`);

  console.log("\n===== ALL PLACEHOLDER PEOPLE =====");
  for (const p of PEOPLE) {
    console.log(`  ${emailToDocId(p.email)}  ${p.name} ${p.surname}  <${p.email}>  ${p.stage}`);
  }
}

run().catch((err) => {
  console.error("Seed failed:", err instanceof Error ? err.message : err);
  Deno.exit(1);
});