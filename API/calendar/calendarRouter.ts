import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import log from "../../helper/log.ts";
import { getGoogleAccessToken } from "../../helper/getGoogleAuthClient.ts";

/**
 * Calendar events listing for ILP (International Legal Partner).
 * Ported from IRP-funnel's calendar router, tailored to ILP:
 * - Google subject email is now configurable via GOOGLE_SUBJECT_EMAIL
 *   (defaults to luisarmando@internationallegalpartner.com).
 * - CALENDAR_ID is read from the environment, same as IRP.
 */
export default (app: Express) => {
  log("Calendar router initialized.");

  const CALENDAR_ID = Deno.env.get("CALENDAR_ID");
  log("CALENDAR_ID loaded from environment.");

  app.get(
    "/api/events",
    asyncHandler(async (_req: Request, res: Response) => {
      log("START: /api/events");

      const token = await getGoogleAccessToken();

      const startTime = new Date();
      startTime.setHours(0, 0, 0, 0);
      log(`Computed startTime: ${startTime.toISOString()}`);

      log("Fetching events from Google Calendar...");
      const params = new URLSearchParams({
        timeMin: startTime.toISOString(),
        orderBy: "startTime",
        singleEvents: "true",
      });
      const url =
        `https://www.googleapis.com/calendar/v3/calendars/${CALENDAR_ID}/events?${params.toString()}`;

      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        const errorData = await response.json();
        log(`Error response: ${JSON.stringify(errorData)}`);
        throw new Error(`Failed to fetch events: ${response.status}`);
      }

      const data = await response.json();
      const events = data.items || [];
      log(`Fetched ${events.length} events.`);
      res.status(200).json(events);
    })
  );
};