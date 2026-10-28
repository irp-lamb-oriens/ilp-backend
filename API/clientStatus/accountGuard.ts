/**
 * API/clientStatus/accountGuard.ts
 * ──────────────────────────────────────────────────────────────────────────
 * DEADLINES: free accounts (contracts.ts accountTypeOf) use Overview,
 * Deadlines, Profile and Privacy. Member-only routes (booking, Money,
 * Messages, Ask my lawyer) answer them with HTTP 402 and
 * `code: "membership_required"`, which the /status pages show as a calm
 * "Join ILP" notice instead of an error. Members are never affected.
 */

import type { NextFunction, Request, Response } from "express";
import get from "../../db/get.ts";
import { type AuthedRequest } from "../../helper/auth/session.ts";
import { type AccountType, accountTypeOf, COLLECTIONS, MEMBERSHIP_REQUIRED } from "../../schemas/contracts.ts";
import { currentMembership } from "../members/service.ts";

export const MEMBERSHIP_REQUIRED_MESSAGE =
  "This is part of the ILP membership. Join to book calls with a lawyer licensed in your country, ask about your deadlines and message your ILP team.";

/** The body a free account gets from a member-only route. */
export const membershipRequiredBody = () => ({ error: MEMBERSHIP_REQUIRED_MESSAGE, code: MEMBERSHIP_REQUIRED });

/** The session's account type (a read error counts as member: never lock a member out). */
export async function accountTypeFor(clientId: string): Promise<AccountType> {
  try {
    const [client, membership] = await Promise.all([get(COLLECTIONS.clients, clientId), currentMembership(clientId)]);
    return accountTypeOf(client as Record<string, unknown> | null, membership);
  } catch {
    return "member";
  }
}

/** Route middleware, after requireClientAuth: 402 for a free account. */
export async function memberOnly(req: Request, res: Response, next: NextFunction): Promise<void> {
  const id = (req as AuthedRequest).clientId;
  if (id && (await accountTypeFor(id)) === "free") {
    res.status(402).json(membershipRequiredBody());
    return;
  }
  next();
}
