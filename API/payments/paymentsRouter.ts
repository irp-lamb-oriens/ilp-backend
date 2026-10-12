import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import validateUser from "../../helper/auth/validateUser.ts";
import log from "../../helper/log.ts";
import { createCheckoutSession } from "../../config/integrations.ts";
import type { SessionUser } from "../../helper/auth/types.ts";

/**
 * ILP payments.
 *
 * Ported from IRP-funnel's paymentsRouter, tailored to ILP:
 * - IRP's mark-paid / payment-metrics endpoints are relocation-specific
 *   (consultation stages + batch counters) and are SKIPPED.
 * - The portable core is checkout-session creation, wired to ILP's
 *   centralized `createCheckoutSession` integration placeholder.
 * - Auth uses ILP's validateUser("customer") instead of IRP's
 *   x-dashboard-token session check.
 *
 * Routes:
 *   POST /api/payments/checkout — create a payment checkout session
 */
export default function paymentsRouter(app: Express) {
  log("Payments router initialized.");

  app.post(
    "/api/payments/checkout",
    validateUser("customer"),
    asyncHandler(async (req: Request, res: Response) => {
      const user = (req as Request & { sessionUser?: SessionUser }).sessionUser!;
      const body = req.body as {
        amount?: number;
        currency?: string;
      };

      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: "A positive amount is required" });
      }

      const session = await createCheckoutSession({
        amount,
        currency: typeof body.currency === "string" && body.currency
          ? body.currency
          : "USD",
        customerId: user.uid,
      });

      res.status(201).json(session);
    })
  );
}