import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import validateUser from "../../helper/auth/validateUser.ts";
import getAll from "../../db/getAll.ts";
import patch from "../../db/patch.ts";
import log from "../../helper/log.ts";
import type { SessionUser } from "../../helper/auth/types.ts";

/**
 * Customer Success follow-up queue + opportunity tracking. Tasks are created
 * by the escalation workflow and by completed consultations.
 */
export default (app: Express) => {
  log("Tasks router initialized.");

  // Staff: list open follow-up tasks.
  app.get(
    "/api/tasks",
    validateUser("staff"),
    asyncHandler(async (_req: Request, res: Response) => {
      const all = await getAll("tasks");
      res.status(200).json(all);
    })
  );

  // Staff: update a task (claim, complete, reassign).
  app.patch(
    "/api/tasks/:id",
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const user = (req as Request & { sessionUser?: SessionUser }).sessionUser!;
      const body = req.body as Record<string, unknown>;
      delete body.id;

      await patch("tasks", req.params.id, {
        ...body,
        assignee: body.assignee ?? user.uid,
        updatedAt: new Date().toISOString(),
      });
      res.status(200).json({ ok: true });
    })
  );
};