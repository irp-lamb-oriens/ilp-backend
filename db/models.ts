/**
 * db/models.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Document-shape types for the ILP Firestore data model.
 *
 * Backward-compatible re-export of the centralized schema system in
 * `schemas/`. New code should import from `schemas/` directly; this file
 * keeps the historical names (`Consultation`, `ClientDoc`, `SessionDoc`,
 * `OtpDoc`, etc.) available so existing importers do not break.
 */
import type {
  ConsultationDoc,
  ClientDoc,
  PricingRequestDoc,
  ClientConversationDoc,
  StatusChatThreadDoc,
} from "../schemas/collections/clients.ts";
import type {
  StageRating,
  StatusComment,
  Charge,
  Quote,
  ClientNote,
  PendingAction,
  JourneyStep,
  CalendarSlot,
} from "../schemas/types.ts";
import type {
  DashboardSession,
  DashboardOtp,
  ClientStatusSession,
  ClientStatusOtp,
} from "../schemas/collections/auth.ts";

export type {
  StageRating,
  StatusComment,
  Charge,
  Quote,
  ClientNote,
  PendingAction,
  JourneyStep,
  CalendarSlot,
  ConsultationDoc,
  ClientDoc,
  PricingRequestDoc,
  ClientConversationDoc,
  StatusChatThreadDoc,
  DashboardSession,
  DashboardOtp,
  ClientStatusSession,
  ClientStatusOtp,
};

/** @deprecated Use `ConsultationDoc` from `schemas/collections/clients.ts`. */
export type Consultation = ConsultationDoc;

/** @deprecated Use `DashboardSession` / `ClientStatusSession`. */
export type SessionDoc = DashboardSession;

/** @deprecated Use `DashboardOtp` / `ClientStatusOtp`. */
export type OtpDoc = DashboardOtp;