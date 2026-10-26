import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { runCronJob } from "../jobs/cronRunner.ts";

/** P4: failing cron jobs reach reportError. Run: deno test --allow-env test/cronRunner_test.ts */

const direct = (fn: () => Promise<unknown>) => fn();

Deno.test("a failing job is reported as kind job and gets an error heartbeat", async () => {
  const reports: Array<[string, unknown]> = [];
  const beats: string[] = [];
  const out = await runCronJob(
    { name: "retentionSweep", handler: () => Promise.reject(new Error("boom")) },
    direct,
    {
      report: (err, ctx) => {
        reports.push([(err as Error).message, ctx]);
        return Promise.resolve("err_1");
      },
      heartbeat: (name, status) => {
        beats.push(`${name}:${status}`);
        return Promise.resolve();
      },
    },
  );
  assertEquals(out, "error");
  assertEquals(reports, [["boom", { kind: "job", route: "job retentionSweep" }]]);
  assertEquals(beats, ["retentionSweep:error"]);
});

Deno.test("a successful job is not reported", async () => {
  let reported = 0;
  const beats: string[] = [];
  const out = await runCronJob({ name: "ok", handler: () => Promise.resolve() }, direct, {
    report: () => {
      reported++;
      return Promise.resolve("x");
    },
    heartbeat: (name, status) => {
      beats.push(`${name}:${status}`);
      return Promise.resolve();
    },
  });
  assertEquals([out, reported, beats], ["ok", 0, ["ok:ok"]]);
});
