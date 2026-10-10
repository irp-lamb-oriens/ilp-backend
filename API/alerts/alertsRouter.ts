import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import validateUser from "../../helper/auth/validateUser.ts";
import get from "../../db/get.ts";
import patch from "../../db/patch.ts";
import query from "../../db/query.ts";
import log from "../../helper/log.ts";
import auditLog, { auditFrom } from "../../helper/auditLog.ts";
import type { SessionUser } from "../../helper/auth/types.ts";

/** Valid response actions a user can file against an alert. */
const RESPONSE_ACTIONS = [
  "paid",
  "not_paid",
  "need_help",
  "sold_asset",
  "incorrect_deadline",
  "evidence_uploaded",
] as const;
type ResponseAction = (typeof RESPONSE_ACTIONS)[number];

/**
 * Smart Compliance Alerts engine. The public acquisition wedge:
 * Profile -> Obligation -> Alert -> Response -> Follow-up -> Profile update.
 */
export default (app: Express) => {
  log("Alerts router initialized.");

  // List the current user's alerts.
  app.get(
    "/api/alerts",
    validateUser("customer"),
    asyncHandler(async (req: Request, res: Response) => {
      const user = (req as Request & { sessionUser?: SessionUser }).sessionUser!;
      const alerts = await getAllForProfile(user.uid);
      res.status(200).json(alerts);
    })
  );

  // Respond to an alert through the micro-form.
  app.post(
    "/api/alerts/:id/respond",
    validateUser("customer"),
    asyncHandler(async (req: Request, res: Response) => {
      const user = (req as Request & { sessionUser?: SessionUser }).sessionUser!;
      const action = (req.body?.action ?? "") as ResponseAction;
      const note = (req.body?.note ?? "") as string;

      if (!RESPONSE_ACTIONS.includes(action)) {
        return res.status(400).json({
          error: `action must be one of: ${RESPONSE_ACTIONS.join(", ")}`,
        });
      }

      const alert = await get("alerts", req.params.id);
      if (!alert) return res.status(404).json({ error: "alert not found" });

      if ((alert.profileId as string) !== user.uid) {
        return res.status(403).json({ error: "not your alert" });
      }

      const now = new Date().toISOString();
      await patch("alerts", req.params.id, {
        status: action === "need_help" ? "needs_help" : "responded",
        response: { action, note, at: now },
        updatedAt: now,
      });

      await auditLog({
        actor: auditFrom(user),
        action: `alert.${action}`,
        target: `alerts/${req.params.id}`,
        meta: { note },
      });

      res.status(200).json({ ok: true, action });
    })
  );
};

async function getAllForProfile(uid: string): Promise<Record<string, unknown>[]> {
  // Real single-field index query. The alert engine writes `profileId` = uid.
  return await query("alerts", [{ field: "profileId", op: "EQUAL", value: uid }]);
}
