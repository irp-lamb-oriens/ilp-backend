import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { parseCookies, serializeCookie, SESSION_COOKIES } from "../helper/auth/cookies.ts";
import { staffRoleFor } from "../helper/auth/roles.ts";
import { normalizeStaffRole } from "../helper/auth/session.ts";

/** Run: deno test --allow-env test/authCookies_test.ts */

Deno.test("cookie names are stable (frontend W2 depends on them)", () => {
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
