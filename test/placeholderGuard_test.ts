import { assertEquals, assertThrows } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import {
  assertPlaceholderDoc,
  assertPlaceholderId,
  deliverableRecipients,
  isPlaceholderDoc,
  isReservedEmail,
  PlaceholderGuardError,
} from "../helper/placeholder.ts";
import { enqueueEmail } from "../helper/emailQueue.ts";
import { sendEmailTransport } from "../config/integrations.ts";
import { sendPushNotification } from "../config/push.ts";
import { buildTask, taskIdFor } from "../API/members/events.ts";

/**
 * Placeholder (seed) data guards: reserved email domains never receive mail,
 * the seeder only writes ph_ ids, and tasks about seed members are seed data.
 * Run: deno test --allow-env --allow-read test/placeholderGuard_test.ts
 */

Deno.test("reserved domains: example.com/.org/.net and .test/.invalid/.example/.localhost", () => {
  for (const e of [
    "a@example.com", "A@EXAMPLE.COM", "x@mail.example.org", "y@example.net", "z@foo.test",
    "q@bar.invalid", "w@site.example", "dev@box.localhost", "Name <n@example.com>",
  ]) assertEquals(isReservedEmail(e), true, e);
  for (const e of [
    "luis@gmail.com", "info@internationallegalpartner.com", "a@example.co", "a@notexample.com",
    "a@testing.com", "", "no-at-sign", null,
  ]) assertEquals(isReservedEmail(e), false, String(e));
});

Deno.test("deliverableRecipients splits strings and arrays and drops reserved addresses", () => {
  const r = deliverableRecipients("ok@gmail.com, ph@example.com; other@foo.test");
  assertEquals(r.kept, ["ok@gmail.com"]);
  assertEquals(r.dropped, ["ph@example.com", "other@foo.test"]);
  assertEquals(deliverableRecipients(["a@example.net", "b@ilp.cr"]).kept, ["b@ilp.cr"]);
  assertEquals(deliverableRecipients(undefined).kept, []);
});

Deno.test("enqueueEmail skips reserved recipients and placeholder records without touching the queue", async () => {
  // No Firestore in this test: a write would throw, so returning proves nothing was queued.
  assertEquals(await enqueueEmail({ to: "member@example.com", subject: "s", html: "h" }, "k1"), "dedupe_k1");
  assertEquals(await enqueueEmail({ to: "a@example.org, b@x.test", subject: "s", html: "h" }), "skipped_placeholder");
  assertEquals(await enqueueEmail({ to: "real@gmail.com", subject: "s", html: "h", placeholder: true }, "k2"), "dedupe_k2");
});

Deno.test("sendEmailTransport never opens SMTP for reserved recipients or placeholder records", async () => {
  // SMTP env is unset: reaching the transport would throw NOT_IMPLEMENTED.
  await sendEmailTransport({ to: "member@example.com", subject: "s", html: "h", cc: ["c@example.net"] });
  await sendEmailTransport({ to: "real@gmail.com", subject: "s", html: "h", placeholder: true });
  let threw = false;
  try {
    await sendEmailTransport({ to: "real@gmail.com, ph@example.com", subject: "s", html: "h" });
  } catch (e) {
    threw = String(e instanceof Error ? e.message : e).includes("NOT_IMPLEMENTED");
  }
  assertEquals(threw, true, "a real recipient still goes to the transport");
});

Deno.test("push is skipped for placeholder records and reserved-domain accounts", async () => {
  const sub = { endpoint: "https://push.invalid/x", keys: { p256dh: "", auth: "" } };
  assertEquals(await sendPushNotification(sub as never, { title: "t", body: "b" }, { placeholder: true }), { ok: false, gone: false });
  assertEquals(await sendPushNotification(sub as never, { title: "t", body: "b" }, { email: "m@example.com" }), { ok: false, gone: false });
});

Deno.test("seeder write guard: only ph_ ids (and the one allowed login alias) pass", () => {
  assertPlaceholderId("memberships", "ph_mem_001");
  assertPlaceholderId("clients", "luis_gmail_com", new Set(["luis_gmail_com"]));
  assertThrows(() => assertPlaceholderId("memberships", "mem_001"), PlaceholderGuardError);
  assertThrows(() => assertPlaceholderId("memberships", "luis_gmail_com", new Set(["luis_gmail_com"])), PlaceholderGuardError);
  assertThrows(() => assertPlaceholderId("clients", "robert_hayes_example_com"), PlaceholderGuardError);
  assertThrows(() => assertPlaceholderId("clients", "PH_upper"), PlaceholderGuardError);
  assertPlaceholderDoc("matters", "ph_mat_1", { placeholder: true });
  assertThrows(() => assertPlaceholderDoc("matters", "ph_mat_1", { placeholder: "true" }), PlaceholderGuardError);
});

Deno.test("isPlaceholderDoc: flag or ph_ id", () => {
  assertEquals(isPlaceholderDoc({ id: "ph_x" }), true);
  assertEquals(isPlaceholderDoc({ id: "real", placeholder: true }), true);
  assertEquals(isPlaceholderDoc({ id: "real" }), false);
  assertEquals(isPlaceholderDoc(null), false);
});

Deno.test("tasks about placeholder members get a ph_ id and the placeholder flag", () => {
  const now = new Date("2026-10-27T15:00:00Z");
  const t = buildTask("membership.activated", { clientId: "ph_cli_007", sourceId: "ph_mem_007" }, now) as unknown as Record<string, unknown>;
  assertEquals(String(t.id).startsWith("ph_task_membership_activated__"), true, String(t.id));
  assertEquals(t.placeholder, true);
  assertEquals(taskIdFor("membership.activated", { clientId: "real_member", sourceId: "mem_1" }), "task_membership_activated__mem_1");
  const real = buildTask("membership.activated", { clientId: "real_member", sourceId: "mem_1" }, now) as unknown as Record<string, unknown>;
  assertEquals(real.placeholder, undefined);
});
