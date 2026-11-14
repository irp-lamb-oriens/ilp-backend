/**
 * helper/auth/alwaysAllowed.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Addresses outside the ILP domain that pass every sign-in gate, whatever the
 * env says:
 *   - staff sign-in (/dashboard, /csm) and the audited staff bypass into
 *     /lawyer and /status (otp.ts extraStaffEmails, isAllowedDomain);
 *   - the admin role (roles.ts adminEmails);
 *   - the lawyer sign-in without a providers record (providerAuthRouter);
 *   - the member sign-in without a clients record (clientStatusRouter
 *     creates one on the first code request).
 * DASHBOARD_EXTRA_ALLOWED_EMAILS / ADMIN_EMAILS still add more addresses.
 */
export const ALWAYS_ALLOWED_EMAILS: readonly string[] = [
  "hello@nathaliehowell.com",
  "admin@internationalrelocationpartner.com",
];

export function isAlwaysAllowed(email: string | null | undefined): boolean {
  const e = String(email ?? "").trim().toLowerCase();
  return !!e && ALWAYS_ALLOWED_EMAILS.includes(e);
}
