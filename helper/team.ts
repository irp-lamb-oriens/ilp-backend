/**
 * helper/team.ts — canonical internal-team email addresses for ILP.
 *
 * This is the single source of truth for the default team CC/BCC applied to
 * outbound client-facing emails. `automation/recipientRules.ts` derives its
 * excludable recipient pool from here, so the editor can never drift from what
 * is actually sent.
 *
 * These are sensible defaults for ILP; they can be tuned via env vars in a
 * later phase if an operator wants to change the shared inboxes without a
 * redeploy.
 */

const DOMAIN = "internationallegalpartner.com";

/** Primary team CC (the legal desk that should see every client email). */
export const TEAM_CC = Deno.env.get("TEAM_CC") ?? `team@${DOMAIN}`;

/** Shared inboxes BCC'd on outbound client email by default. */
export const TEAM_BCC: string[] = [
  `pablo@${DOMAIN}`,
  `luisarmando@${DOMAIN}`,
  `oriens@${DOMAIN}`,
];

/** Legal review / pricing desks referenced by recipient rules. */
export const PRICING_DESK_EMAIL = Deno.env.get("PRICING_DESK_EMAIL") ?? `pricing@${DOMAIN}`;
export const FINANCE_DESK_EMAIL = `finance@${DOMAIN}`;
export const SALES_DESK_EMAIL = `oriens@${DOMAIN}`;

/** The full excludable team pool (CC + BCC + desks), de-duplicated. */
export function teamEmailPool(): string[] {
  return [...new Set([
    TEAM_CC,
    ...TEAM_BCC,
    PRICING_DESK_EMAIL,
    FINANCE_DESK_EMAIL,
    SALES_DESK_EMAIL,
  ])].filter((e) => e && e.includes("@"));
}