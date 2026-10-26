import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { securityHeaders } from "../helper/auth/securityHeaders.ts";

/** Run: deno test test/securityHeaders_test.ts */

function run(isProduction: boolean): Record<string, string> {
  const h: Record<string, string> = {};
  // deno-lint-ignore no-explicit-any
  const res: any = { setHeader: (k: string, v: string) => (h[k] = v) };
  let next = false;
  securityHeaders(isProduction)({} as never, res, () => (next = true));
  assertEquals(next, true);
  return h;
}

Deno.test("API sends nosniff, no-referrer and frame-ancestors 'none'", () => {
  const h = run(false);
  assertEquals(h["X-Content-Type-Options"], "nosniff");
  assertEquals(h["Referrer-Policy"], "no-referrer");
  assertEquals(h["Content-Security-Policy"], "frame-ancestors 'none'");
  assertEquals(h["X-Frame-Options"], "DENY");
  assertEquals(h["Strict-Transport-Security"], undefined);
});

Deno.test("HSTS only in production", () => {
  assertEquals(run(true)["Strict-Transport-Security"], "max-age=31536000; includeSubDomains");
});
