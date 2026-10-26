import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { backupDate, firestoreBackup, outputPrefix } from "../jobs/firestoreBackup.ts";

/** Run: deno test --allow-env test/firestoreBackup_test.ts */

Deno.test("backup folder is the Costa Rica date (UTC-6)", () => {
  assertEquals(backupDate(new Date("2026-10-27T09:00:00Z")), "2026-10-27"); // 03:00 CR
  assertEquals(backupDate(new Date("2026-10-27T05:59:00Z")), "2026-10-26"); // 23:59 CR the day before
});

Deno.test("gs:// prefix accepts a bare or gs:// bucket name", () => {
  assertEquals(outputPrefix("ilp-backups", "2026-10-27"), "gs://ilp-backups/2026-10-27");
  assertEquals(outputPrefix("gs://ilp-backups/", "2026-10-27"), "gs://ilp-backups/2026-10-27");
});

Deno.test("no BACKUP_BUCKET: no-op", async () => {
  Deno.env.delete("BACKUP_BUCKET");
  assertEquals(await firestoreBackup(), { skipped: true });
});

Deno.test("registered daily at 09:00 UTC (03:00 Costa Rica)", async () => {
  // Static check: importing the registry pulls in every job module.
  const src = await Deno.readTextFile(new URL("../jobs/registry.ts", import.meta.url));
  assertEquals(/name: "firestoreBackup",\s*cron: "0 9 \* \* \*"/.test(src), true);
});
