import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { movedDoc, planInlineMigration } from "../scripts/migrateInlineDocuments.ts";

/** P4: inline → bucket document migration, pure parts. Run: deno test --allow-env --allow-read test/migrateInlineDocuments_test.ts */

const PDF = btoa("%PDF-1.7\n%âãÏÓ\n1 0 obj\n");
const TEXT = btoa("just some text");

Deno.test("plan: inline PDFs move, GCS docs and bad data are skipped", () => {
  const docs = [
    { id: "doc_1", clientId: "c1", dataBase64: PDF, fileName: "deed.pdf", category: "property" },
    { id: "doc_2", clientId: "c1", storage: "gcs", objectName: "members/c1/doc_2" },
    { id: "doc_3", clientId: "c1", dataBase64: TEXT },
    { id: "doc 4", clientId: "c1", dataBase64: PDF },
    { id: "doc_5", clientId: "c2" },
  ];
  const plan = planInlineMigration(docs);
  assertEquals(plan.move.map((m) => [m.id, m.objectName, m.contentType]), [["doc_1", "members/c1/doc_1", "application/pdf"]]);
  assertEquals(plan.skipped.map((s) => s.id), ["doc_3", "doc 4", "doc_5"]);
});

Deno.test("plan: idempotent once moved, and --only limits to one doc", () => {
  const moved = { id: "doc_1", clientId: "c1", storage: "gcs", objectName: "members/c1/doc_1" };
  assertEquals(planInlineMigration([moved]), { move: [], skipped: [] });
  const docs = [{ id: "a", clientId: "c1", dataBase64: PDF }, { id: "b", clientId: "c1", dataBase64: PDF }];
  assertEquals(planInlineMigration(docs, "b").move.map((m) => m.id), ["b"]);
});

Deno.test("moved doc keeps metadata, drops base64 and id", () => {
  const d = { id: "doc_1", clientId: "c1", dataBase64: PDF, fileName: "deed.pdf", category: "property", storage: "inline" };
  const item = planInlineMigration([d]).move[0];
  const out = movedDoc(d, item, "2026-10-26T12:00:00.000Z");
  assertEquals(out, {
    clientId: "c1",
    fileName: "deed.pdf",
    category: "property",
    storage: "gcs",
    objectName: "members/c1/doc_1",
    contentType: "application/pdf",
    size: item.bytes.length,
    migratedAt: "2026-10-26T12:00:00.000Z",
  });
});
