import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import {
  bearerToken,
  cookieToken,
  isJwt,
  parseCookies,
  roleTokens,
  serializeCookie,
  SESSION_COOKIES,
  setSessionCookie,
} from "../helper/auth/cookies.ts";
import { staffRoleFor } from "../helper/auth/roles.ts";
import { normalizeStaffRole } from "../helper/auth/session.ts";

/**
 * Request-token helpers and the optional cookies (AUTH: Bearer by default,
 * cookies only with AUTH_COOKIES=true).
 * Run: deno test --allow-env test/authCookies_test.ts
 */

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("bearerToken parses Authorization: Bearer; roleTokens orders Bearer, legacy header, cookie", () => {
  assertEquals(bearerToken({ headers: { authorization: "Bearer abc123" } } as Any), "abc123");
  assertEquals(bearerToken({ headers: { authorization: "bearer  abc123 " } } as Any), "abc123");
  assertEquals(bearerToken({ headers: { authorization: "Basic abc" } } as Any), undefined);
  assertEquals(bearerToken({ headers: {} } as Any), undefined);
  assertEquals(isJwt("a.b.c"), true);
  assertEquals(isJwt("f00d"), false);
  Deno.env.delete("AUTH_COOKIES");
  const req = { headers: { authorization: "Bearer b", "x-client-token": "h", cookie: "ilp_client_session=c" } } as Any;
  assertEquals(roleTokens(req, "client"), ["b", "h"]);
  Deno.env.set("AUTH_COOKIES", "true");
  assertEquals(roleTokens(req, "client"), ["b", "h", "c"]);
  Deno.env.delete("AUTH_COOKIES");
});

Deno.test("cookies are off by default: not read, not set", () => {
  Deno.env.delete("AUTH_COOKIES");
  const req = { headers: { cookie: "ilp_staff_session=tok" } } as Any;
  assertEquals(cookieToken(req, "staff"), undefined);
  const headers: Record<string, unknown> = {};
  const res = { getHeader: (k: string) => headers[k], setHeader: (k: string, v: unknown) => (headers[k] = v) } as Any;
  setSessionCookie(res, "staff", "tok");
  assertEquals(headers["Set-Cookie"], undefined);
  Deno.env.set("AUTH_COOKIES", "true");
  assertEquals(cookieToken(req, "staff"), "tok");
  setSessionCookie(res, "staff", "tok");
  assertEquals((headers["Set-Cookie"] as string[]).length, 1);
  Deno.env.delete("AUTH_COOKIES");
});

Deno.test("cookie names are stable (used only with AUTH_COOKIES=true)", () => {
  assertEquals(SESSION_COOKIES, {
    staff: "ilp_staff_session",
    lawyer: "ilp_lawyer_session",
    client: "ilp_client_session",
  });
});

Deno.test("parseCookies reads a Cookie header, first value wins", () => {
  const c = parseCookies("a=1; ilp_staff_session=tok%20en; a=2; junk; =x");
  assertEquals(c.a, "1");
  assertEquals(c.ilp_staff_session, "tok en");
  assertEquals(parseCookies(undefined), {});
});

Deno.test("serializeCookie sets HttpOnly, Secure, SameSite and Max-Age", () => {
  const v = serializeCookie("ilp_client_session", "abc", { maxAgeSec: 3600, sameSite: "Lax", secure: true });
  assertEquals(v, "ilp_client_session=abc; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=3600");
});

Deno.test("serializeCookie: SameSite=None forces Secure; clearing expires the cookie", () => {
  const v = serializeCookie("x", "", { maxAgeSec: 0, sameSite: "None", secure: false, domain: ".ilp.test" });
  assertEquals(v, "x=; Path=/; HttpOnly; SameSite=None; Secure; Domain=.ilp.test; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
});

Deno.test("staff role comes from ADMIN_EMAILS / CSM_EMAILS, default staff", () => {
  Deno.env.set("ADMIN_EMAILS", "boss@internationallegalpartner.com");
  Deno.env.set("CSM_EMAILS", "Carla@internationallegalpartner.com, other@internationallegalpartner.com");
  assertEquals(staffRoleFor("boss@internationallegalpartner.com"), "admin");
  assertEquals(staffRoleFor("carla@internationallegalpartner.com"), "csm");
  assertEquals(staffRoleFor("someone@internationallegalpartner.com"), "staff");
  assertEquals(normalizeStaffRole(undefined), "staff");
  assertEquals(normalizeStaffRole("csm"), "csm");
  assertEquals(normalizeStaffRole("root"), "staff");
});
