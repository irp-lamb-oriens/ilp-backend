import { loadSync } from "dotenv/mod.ts";

loadSync({ export: true, allowEmptyValues: true });
import { getGoogleAccessToken } from "../helper/getGoogleAuthClient.ts";
import log from "../helper/log.ts";

/**
 * Calendar integration smoke test.
 *
 * 1. Obtains a Google access token via the CALENDAR_SERVICE_ACCOUNT_KEY
 *    (domain-wide delegation, impersonating GOOGLE_SUBJECT_EMAIL).
 * 2. Lists events on CALENDAR_ID to prove the service account can read it.
 *
 * Run: deno run --allow-net --allow-env --allow-read test/calendar-test.ts
 */

const CALENDAR_ID = Deno.env.get("CALENDAR_ID") ?? "";
const SUBJECT = Deno.env.get("GOOGLE_SUBJECT_EMAIL");

if (!CALENDAR_ID) {
  console.error("FAIL: CALENDAR_ID is not set.");
  Deno.exit(1);
}
if (!SUBJECT) {
  console.error("FAIL: GOOGLE_SUBJECT_EMAIL is not set.");
  Deno.exit(1);
}

log(`Testing calendar access: ${CALENDAR_ID} as ${SUBJECT}`, "calendar-test");

try {
  const token = await getGoogleAccessToken();
  log("Access token obtained.", "calendar-test");

  const now = new Date();
  const timeMin = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "5",
  });

  const url =
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events?${params.toString()}`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  if (!res.ok) {
    const body = await res.text();
    console.error(`FAIL: list events returned ${res.status}: ${body}`);
    Deno.exit(1);
  }

  const data = await res.json();
  const items = data.items ?? [];
  console.log(`\n===== CALENDAR TEST RESULTS =====`);
  console.log(`PASS: read access to ${CALENDAR_ID}`);
  console.log(`Events in window: ${items.length}`);
  for (const e of items.slice(0, 5)) {
    console.log(`  - ${e.summary ?? "(no summary)"} @ ${e.start?.dateTime ?? e.start?.date ?? "?"}`);
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`FAIL: ${message}`);
  Deno.exit(1);
}