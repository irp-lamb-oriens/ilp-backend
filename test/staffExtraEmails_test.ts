import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { extraStaffEmails, isAllowedDomain } from "../helper/auth/otp.ts";
import { staffRoleFor } from "../helper/auth/roles.ts";

/**
 * DASHBOARD_EXTRA_ALLOWED_EMAILS: staff logins outside the staff domain (off by default).
 * Run: deno test --allow-env test/staffExtraEmails_test.ts
 */

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const before = Object.fromEntries(Object.keys(env).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(env)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(before)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
  }
}

Deno.test("staff extra emails: off by default, only the staff domain signs in", () => {
  withEnv({ DASHBOARD_EXTRA_ALLOWED_EMAILS: undefined, DASHBOARD_ALLOWED_DOMAIN: undefined }, () => {
    assertEquals(extraStaffEmails(), []);
    assertEquals(isAllowedDomain("ana@internationallegalpartner.com"), true);
    assertEquals(isAllowedDomain("merlin@aiexecutions.com"), false);
    assertEquals(isAllowedDomain(""), false);
  });
  withEnv({ DASHBOARD_EXTRA_ALLOWED_EMAILS: "" }, () => assertEquals(isAllowedDomain("merlin@aiexecutions.com"), false));
});

Deno.test("staff extra emails: listed addresses sign in (trimmed, quoted, case-insensitive); others still refused", () => {
  withEnv({ DASHBOARD_EXTRA_ALLOWED_EMAILS: ` "Merlin@AIExecutions.com" ; other@x.io,not-an-email`, DASHBOARD_ALLOWED_DOMAIN: undefined }, () => {
    assertEquals(extraStaffEmails(), ["merlin@aiexecutions.com", "other@x.io"]);
    assertEquals(isAllowedDomain("merlin@aiexecutions.com"), true);
    assertEquals(isAllowedDomain(" MERLIN@aiexecutions.com "), true);
    assertEquals(isAllowedDomain("someone@aiexecutions.com"), false, "the list is per address, not per domain");
    assertEquals(isAllowedDomain("ana@internationallegalpartner.com"), true, "the domain still works");
    assertEquals(isAllowedDomain("not-an-email"), false);
  });
});

Deno.test("staff extra emails: the role still comes from ADMIN_EMAILS / CSM_EMAILS", () => {
  withEnv({ DASHBOARD_EXTRA_ALLOWED_EMAILS: "merlin@aiexecutions.com", ADMIN_EMAILS: "boss@internationallegalpartner.com", CSM_EMAILS: "", OWNER_EMAILS: "" }, () => {
    assertEquals(staffRoleFor("merlin@aiexecutions.com"), "staff");
  });
  withEnv({ DASHBOARD_EXTRA_ALLOWED_EMAILS: "merlin@aiexecutions.com", ADMIN_EMAILS: "boss@internationallegalpartner.com,merlin@aiexecutions.com" }, () => {
    assertEquals(staffRoleFor("merlin@aiexecutions.com"), "admin");
  });
});
