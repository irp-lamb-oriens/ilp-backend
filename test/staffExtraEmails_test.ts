import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { extraStaffEmails, isAllowedDomain } from "../helper/auth/otp.ts";
import { staffRoleFor } from "../helper/auth/roles.ts";
import { ALWAYS_ALLOWED_EMAILS } from "../helper/auth/alwaysAllowed.ts";

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
    assertEquals(extraStaffEmails(), [...ALWAYS_ALLOWED_EMAILS], "only the always-allowed addresses");
    assertEquals(isAllowedDomain("ana@internationallegalpartner.com"), true);
    assertEquals(isAllowedDomain("merlin@aiexecutions.com"), false);
    assertEquals(isAllowedDomain(""), false);
  });
  withEnv({ DASHBOARD_EXTRA_ALLOWED_EMAILS: "" }, () => assertEquals(isAllowedDomain("merlin@aiexecutions.com"), false));
});

Deno.test("staff extra emails: listed addresses sign in (trimmed, quoted, case-insensitive); others still refused", () => {
  withEnv({ DASHBOARD_EXTRA_ALLOWED_EMAILS: ` "Merlin@AIExecutions.com" ; other@x.io,not-an-email`, DASHBOARD_ALLOWED_DOMAIN: undefined }, () => {
    assertEquals(extraStaffEmails(), ["merlin@aiexecutions.com", "other@x.io", ...ALWAYS_ALLOWED_EMAILS]);
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

Deno.test("always-allowed address: staff sign-in and admin role with no env set", () => {
  withEnv({ DASHBOARD_EXTRA_ALLOWED_EMAILS: undefined, ADMIN_EMAILS: undefined, OWNER_EMAILS: undefined, CSM_EMAILS: undefined }, () => {
    assertEquals(isAllowedDomain("hello@nathaliehowell.com"), true);
    assertEquals(isAllowedDomain(" Hello@NathalieHowell.com "), true);
    assertEquals(isAllowedDomain("other@nathaliehowell.com"), false, "per address, not per domain");
    assertEquals(staffRoleFor("hello@nathaliehowell.com"), "admin");
    assertEquals(isAllowedDomain("Admin@InternationalRelocationPartner.com"), true);
    assertEquals(isAllowedDomain("pablo@internationalrelocationpartner.com"), false, "per address, not per domain");
    assertEquals(staffRoleFor("admin@internationalrelocationpartner.com"), "admin");
  });
});
