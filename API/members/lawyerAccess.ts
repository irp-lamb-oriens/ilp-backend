/**
 * API/members/lawyerAccess.ts — which members a lawyer may read (REL).
 * ──────────────────────────────────────────────────────────────────────────
 * One rule for the member bundle (/api/lawyer/members/:id), the inspector
 * brief (/api/provider/clients/:id/brief), the call brief and member
 * documents (/api/provider/members/:id/documents). A lawyer works with a
 * member while:
 *   - the member is assigned to them (clients.assignedProviderId), or
 *   - an open matter of the member is assigned to them, or
 *   - they hold a booked / in-progress call with the member, or
 *   - they took a call with the member and still owe its handoff
 *     (completed, no handoffId yet).
 * After a reassignment the previous lawyer keeps their own calls' records
 * (ownership checks on /consultations/:id) and their payouts, but no longer
 * reads the member's profile, matters or documents. Pure; tested.
 */

import type { Consultation, Matter } from "../../schemas/contracts.ts";

type Doc = Record<string, unknown>;

export function lawyerMaySee(
  providerId: string,
  client: Doc | null | undefined,
  matters: Array<Pick<Matter, "assignedProviderId" | "closedAt">>,
  consultations: Array<Pick<Consultation, "providerId" | "status" | "handoffId">>,
): boolean {
  if (!providerId || !client) return false;
  if (client.assignedProviderId === providerId) return true;
  if (matters.some((m) => !m.closedAt && m.assignedProviderId === providerId)) return true;
  return consultations.some((c) =>
    c.providerId === providerId &&
    (c.status === "booked" || c.status === "in_progress" || (c.status === "completed" && !c.handoffId))
  );
}
