import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import validateUser from "../../helper/auth/validateUser.ts";
import get from "../../db/get.ts";
import patch from "../../db/patch.ts";
import log from "../../helper/log.ts";
import { listAvailableSlots, createCalendarEvent } from "../../config/integrations.ts";
import { enqueueEmail } from "../../helper/emailQueue.ts";
import { consultationConfirmationEmail } from "../../helper/emailTemplates.ts";
import { bookConsultation } from "../../helper/bookConsultation.ts";
import type { SessionUser } from "../../helper/auth/types.ts";

/**
 * Booking engine. Alerts / updates / templates all produce a pre-filled
 * consultation request: user, country, topic, source event, profile context.
 */
export default (app: Express) => {
  log("Consultations router initialized.");

  // Customer: list available slots for a provider.
  app.get(
    "/api/consultations/slots/:providerId",
    validateUser("customer"),
    asyncHandler(async (req: Request, res: Response) => {
      const from = (req.query.from as string) ?? new Date().toISOString();
      const to = (req.query.to as string) ??
        new Date(Date.now() + 14 * 86400_000).toISOString();
      const slots = await listAvailableSlots({
        providerId: req.params.providerId,
        from,
        to,
      });
      res.status(200).json(slots);
    })
  );

  // Customer: create a booking request (pre-filled from a source event).
  app.post(
    "/api/consultations",
    validateUser("customer"),
    asyncHandler(async (req: Request, res: Response) => {
      const user = (req as Request & { sessionUser?: SessionUser }).sessionUser!;
      const body = req.body as {
        providerId?: string;
        slot?: { start: string; end: string; timezone: string };
        source?: string;
        sourceId?: string;
        topic?: string;
        notes?: unknown;
      };

      if (!body.providerId || !body.slot?.start) {
        return res.status(400).json({ error: "providerId and slot are required" });
      }

      const result = await bookConsultation({
        customerId: user.uid,
        providerId: body.providerId,
        slot: body.slot,
        source: body.source,
        sourceId: body.sourceId,
        topic: body.topic,
        notes: body.notes,
      });

      if (!result.success) {
        return res.status(409).json({ error: result.reason, code: result.code });
      }

      res.status(result.alreadyExisted ? 200 : 201).json({ id: result.id });
    })
  );

  // Provider: accept a consultation and create the calendar event.
  app.patch(
    "/api/consultations/:id/accept",
    validateUser("provider"),
    asyncHandler(async (req: Request, res: Response) => {
      const existing = await get("consultations", req.params.id);
      if (!existing) return res.status(404).json({ error: "not found" });

      // Idempotent accept: a second accept returns the existing event instead
      // of creating a duplicate calendar event.
      if (existing.status === "confirmed" && existing.eventId) {
        return res.status(200).json({ ok: true, eventId: existing.eventId });
      }

      const slot = existing.slot as { start: string; end: string; timezone: string };
      const event = await createCalendarEvent({
        slot,
        title: `Consultation: ${existing.topic ?? ""}`,
      });

      // Resolve the two fields the confirmation email needs. They are looked up
      // at send-time because the request doc only stores ids.
      const customerId = existing.customerId as string | undefined;
      const profile = customerId
        ? await get("profiles", `profile_${customerId}`)
        : null;
      const customerEmail =
        (existing.customerEmail as string | undefined) ??
        (profile?.email as string | undefined);
      const firstName =
        (existing.customerFirstName as string | undefined) ??
        (profile?.firstName as string | undefined) ?? "";

      const providerId = existing.providerId as string | undefined;
      const provider = providerId
        ? await get("providers", providerId)
        : null;
      const providerName =
        (existing.providerName as string | undefined) ??
        (provider?.name as string | undefined) ??
        "your Legal Partner";

      await patch("consultations", req.params.id, {
        status: "confirmed",
        eventId: event.eventId,
        meetingUrl: event.htmlLink ?? null,
        confirmedAt: new Date().toISOString(),
        customerEmail: customerEmail ?? null,
        providerName,
        meetingUrlText: event.htmlLink ?? "",
      });

      if (customerEmail) {
        await enqueueEmail(
          {
            to: customerEmail,
            subject: "Consultation confirmed",
            html: consultationConfirmationEmail({
              firstName,
              providerName,
              slotLabel: slot.start,
              meetingUrl: event.htmlLink,
            }),
          },
          `confirmation_${req.params.id}`,
        );
      }

      res.status(200).json({ ok: true, eventId: event.eventId });
    })
  );
};
