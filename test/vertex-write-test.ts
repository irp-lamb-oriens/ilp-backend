import { loadSync } from "dotenv/mod.ts";

loadSync({ export: true, allowEmptyValues: true });
import put from "../db/put.ts";
import get from "../db/get.ts";
import log from "../helper/log.ts";

/**
 * Vertex write test: writes a `test: true` document to every Firestore
 * collection the ILP backend touches, reads it back, and reports whether it
 * persisted. Every test document carries `test: true` plus a `test-` prefixed
 * id so it can be swept later.
 *
 * Run: deno run --allow-net --allow-env --allow-read test/vertex-write-test.ts
 */

const COLLECTIONS = [
  "profiles",
  "rules",
  "alerts",
  "updates",
  "templates",
  "template_downloads",
  "consultations",
  "providers",
  "tasks",
  "leads",
  "posts",
  "invoices",
  "audit_log",
];

interface Result {
  collection: string;
  id: string;
  persisted: boolean;
  tagged: boolean;
  error?: string;
}

const results: Result[] = [];
const runId = Date.now();

for (const collection of COLLECTIONS) {
  const id = `test-${collection}-${runId}`;
  try {
    await put(collection, id, {
      test: true,
      testCollection: collection,
      testRunId: runId,
      createdAt: new Date().toISOString(),
    });

    const doc = await get(collection, id);
    const persisted = !!doc;
    const tagged = doc?.test === true;

    results.push({ collection, id, persisted, tagged });
    log(
      `${persisted && tagged ? "PASS" : "FAIL"} ${collection} -> ${id}`,
      "vertex-test",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ collection, id, persisted: false, tagged: false, error: message });
    log(`ERROR ${collection}: ${message}`, "vertex-test");
  }
}

const passed = results.filter((r) => r.persisted && r.tagged).length;
const failed = results.length - passed;

console.log("\n===== VERTEX WRITE TEST RESULTS =====");
console.log(`Passed: ${passed}/${results.length}`);
console.log(`Failed: ${failed}`);
for (const r of results) {
  const status = r.persisted && r.tagged ? "PASS" : "FAIL";
  console.log(
    `[${status}] ${r.collection} (${r.id})${r.error ? ` — ${r.error}` : ""}`,
  );
}