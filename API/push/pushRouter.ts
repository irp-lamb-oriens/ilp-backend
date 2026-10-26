/**
 * API/push/pushRouter.ts — browser push subscription management.
 * ──────────────────────────────────────────────────────────────────────────
 * Stores a client's Web Push subscription so the deadline sweep can send
 * browser notifications. Subscriptions are keyed by the client's email
 * (email-normalized doc id) so a single client can hold one active
 * subscription per browser.
 *
 * Routes:
 *   GET  /api/push/vapid-public-key   — the VAPID public key (base64url)
 *   POST /api/push/subscribe          — upsert a subscription for the client
 *   DELETE /api/push/subscribe        — remove the client's subscription
 *
 * Auth: `requireClientAuth` (staff bypass via x-dashboard-token, end-customer
 * via x-client-token), matching the client-status portal.
 */

import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import log from "../../helper/log.ts";
import get from "../../db/get.ts";
import put from "../../db/put.ts";
import remove from "../../db/delete.ts";
import { requireClientAuth } from "../../helper/auth/session.ts";
import { emailToDocId } from "../../helper/auth/otp.ts";
import { getVapidPublicKey, type PushSubscription } from "../../config/push.ts";

const SUBSCRIPTIONS_COLLECTION = "push_subscriptions";

interface AuthedRequest extends Request {
  clientUser?: string;
}

function viewerEmail(req: Request): string {
  return String((req as AuthedRequest).clientUser ?? "").toLowerCase().trim();
}

export default function pushRouter(app: Express): void {
  // Public: the browser needs the VAPID public key before it can subscribe.
  app.get(
    "/api/push/vapid-public-key",
    asyncHandler(async (_req: Request, res: Response) => {
      const publicKey = await getVapidPublicKey();
      res.json({ publicKey });
    }),
  );

  // Upsert a subscription for the signed-in client.
  app.post(
    "/api/push/subscribe",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const email = viewerEmail(req);
      if (!email) {
        return res.status(401).json({ error: "Authentication required." });
      }

      const sub = req.body?.subscription as PushSubscription | undefined;
      if (
        !sub ||
        typeof sub.endpoint !== "string" ||
        !sub.endpoint.startsWith("https://") ||
        !sub.keys ||
        typeof sub.keys.p256dh !== "string" ||
        typeof sub.keys.auth !== "string"
      ) {
        return res.status(400).json({ error: "A valid push subscription is required." });
      }

      const id = emailToDocId(email);
      await put(SUBSCRIPTIONS_COLLECTION, id, {
        email,
        subscription: sub,
        updatedAt: new Date().toISOString(),
      });

      log(`[push] subscription saved for ${email}`, "push");
      res.json({ ok: true });
    }),
  );

  // Remove the signed-in client's subscription.
  app.delete(
    "/api/push/subscribe",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const email = viewerEmail(req);
      if (!email) {
        return res.status(401).json({ error: "Authentication required." });
      }

      const id = emailToDocId(email);
      const existing = await get(SUBSCRIPTIONS_COLLECTION, id);
      if (!existing) return res.json({ ok: true });

      await remove(SUBSCRIPTIONS_COLLECTION, id);
      log(`[push] subscription removed for ${email}`, "push");
      res.json({ ok: true });
    }),
  );

  log("Push router initialized.");
}