import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import {
  DOCUMENT_MAX_BYTES,
  DOCUMENT_TYPES,
  documentMeta,
  objectNameFor,
  safeFileName,
  safeId,
  sniffContentType,
  storageMode,
  storeMemberDocument,
  uploadBytes,
} from "../helper/storage.ts";

/**
 * P1 private document storage: type allowlist by magic bytes, size cap,
 * object naming, storage mode selection and the dev-only inline fallback.
 * No network: the GCS path is not exercised here.
 *
 * Run: deno test --allow-env test/storage_test.ts
 */

const bytes = (...xs: number[]) => new Uint8Array(xs);
const withText = (head: number[], text: string) => new Uint8Array([...head, ...new TextEncoder().encode(text)]);

Deno.test("sniff: pdf, jpg, png, heic and docx are recognised from their bytes", () => {
  assertEquals(sniffContentType(withText([], "%PDF-1.7\n")), DOCUMENT_TYPES.pdf);
  assertEquals(sniffContentType(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10)), DOCUMENT_TYPES.jpg);
  assertEquals(sniffContentType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)), DOCUMENT_TYPES.png);
  assertEquals(sniffContentType(withText([0, 0, 0, 0x18], "ftypheic\0\0\0\0")), DOCUMENT_TYPES.heic);
  assertEquals(sniffContentType(withText([0x50, 0x4b, 0x03, 0x04], "....[Content_Types].xml....word/document.xml")), DOCUMENT_TYPES.docx);
});

Deno.test("sniff: other files are refused (html, exe, plain zip, xlsx, svg)", () => {
  assertEquals(sniffContentType(withText([], "<html><script>alert(1)</script>")), null);
  assertEquals(sniffContentType(bytes(0x4d, 0x5a, 0x90, 0)), null);
  assertEquals(sniffContentType(withText([0x50, 0x4b, 0x03, 0x04], "....xl/workbook.xml")), null);
  assertEquals(sniffContentType(withText([], "<svg xmlns=")), null);
  assertEquals(sniffContentType(new Uint8Array()), null);
});

Deno.test("object names: members/<clientId>/<docId>, no traversal", () => {
  assertEquals(objectNameFor("robert_hayes_gmail_com", "doc_abc123"), "members/robert_hayes_gmail_com/doc_abc123");
  assertEquals(safeId("../etc"), null);
  assertEquals(safeId("a/b"), null);
  let threw = false;
  try {
    objectNameFor("x", "../../y");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("file names are header-safe and keep the real extension", () => {
  assertEquals(safeFileName('pass"port\r\n.pdf', DOCUMENT_TYPES.pdf), "passport.pdf");
  assertEquals(safeFileName("deed.exe", DOCUMENT_TYPES.pdf), "deed.pdf");
  assertEquals(safeFileName("photo.jpeg", DOCUMENT_TYPES.jpg), "photo.jpeg");
  assertEquals(safeFileName("cédula", DOCUMENT_TYPES.png), "c_dula.png");
});

Deno.test("storage mode: bucket → gcs; none in dev → inline; none in production → unavailable", () => {
  Deno.env.set("DOCUMENT_BUCKET", "ilp-docs");
  assertEquals(storageMode(), "gcs");
  Deno.env.delete("DOCUMENT_BUCKET");
  Deno.env.delete("RENDER_EXTERNAL_URL");
  assertEquals(storageMode(), "inline");
  Deno.env.set("RENDER_EXTERNAL_URL", "https://api.example.com");
  assertEquals(storageMode(), "unavailable");
  Deno.env.delete("RENDER_EXTERNAL_URL");
});

Deno.test("store: size cap, type refusal, production without bucket, inline dev fallback", async () => {
  Deno.env.delete("DOCUMENT_BUCKET");
  Deno.env.delete("RENDER_EXTERNAL_URL");
  const pdf = withText([], "%PDF-1.4 hello");
  const big = new Uint8Array(DOCUMENT_MAX_BYTES + 1);
  big.set(pdf);
  const r1 = await storeMemberDocument("c1", "d1", big);
  assertEquals(r1.ok ? 0 : r1.status, 413);
  const r2 = await storeMemberDocument("c1", "d1", withText([], "<html>"));
  assertEquals(r2.ok ? 0 : r2.status, 415);
  const r3 = await storeMemberDocument("c1", "d1", pdf);
  assertEquals(r3.ok && r3.fields.storage === "inline" && r3.contentType === DOCUMENT_TYPES.pdf, true);
  assertEquals(r3.ok && uploadBytes({ dataBase64: r3.fields.dataBase64 })?.length, pdf.length);
  Deno.env.set("RENDER_EXTERNAL_URL", "https://api.example.com");
  const r4 = await storeMemberDocument("c1", "d1", pdf);
  assertEquals(r4.ok ? 0 : r4.status, 503);
  Deno.env.delete("RENDER_EXTERNAL_URL");
});

Deno.test("metadata never exposes bytes or the bucket path", () => {
  assertEquals(documentMeta({ id: "d", fileName: "x.pdf", dataBase64: "AAA", objectName: "members/c/d" }), { id: "d", fileName: "x.pdf" });
});
