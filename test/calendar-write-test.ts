import { loadSync } from "dotenv/mod.ts";

loadSync({ export: true, allowEmptyValues: true });
import { getGoogleAccessToken } from "../helper/getGoogleAuthClient.ts";
import log from "../helper/log.ts";

/**
 * Calendar write smoke test: creates a test event, reads it back, then
 * deletes it. Proves the service account has full read/write on CALENDAR_ID.
 *
 * Run: deno run --allow-net --allow-env --allow-read test/calendar-write-test.ts
 */

const CALENDAR_ID = Deno.env.get("CALENDAR_ID");
if (!CALENDAR_ID) {
  console.error("FAIL: CALENDAR_ID is not set.");
  Deno.exit(1);
}

const base =
  `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events`;

const start = new Date(Date.now() + 60 * 60 * 1000);
const end = new Date(start.getTime() + 30 * 60 * 1000);

try {
  const token = await getGoogleAccessToken();

  // 1. Create
  const createRes = await fetch(`${base}?conferenceDataVersion=1`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      summary: "ILP calendar write test",
      description: "Temporary event created by calendar-write-test.ts",
      start: { dateTime: start.toISOString(), timeZone: "America/Costa_Rica" },
      end: { dateTime: end.toISOString(), timeZone: "America/Costa_Rica" },
    }),
  });

  if (!createRes.ok) {
    const body = await createRes.text();
    console.error(`FAIL: create returned ${createRes.status}: ${body}`);
    Deno.exit(1);
  }

  const created = await createRes.json();
  const eventId = created.id;
  log(`Created test event ${eventId}`, "calendar-write-test");

  // 2. Read back
  const getRes = await fetch(`${base}/${encodeURIComponent(eventId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!getRes.ok) {
    const body = await getRes.text();
    console.error(`FAIL: read-back returned ${getRes.status}: ${body}`);
    Deno.exit(1);
  }
  const readBack = await getRes.json();

  // 3. Delete
  const delRes = await fetch(`${base}/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!delRes.ok) {
    const body = await delRes.text();
    console.error(`FAIL: delete returned ${delRes.status}: ${body}`);
    Deno.exit(1);
  }

  console.log(`\n===== CALENDAR WRITE TEST RESULTS =====`);
  console.log(`PASS: create + read + delete on ${CALENDAR_ID}`);
  console.log(`  created: ${readBack.summary}`);
  console.log(`  start:   ${readBack.start?.dateTime}`);
  console.log(`  deleted: ${eventId}`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`FAIL: ${message}`);
  Deno.exit(1);
}