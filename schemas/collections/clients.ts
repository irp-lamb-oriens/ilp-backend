/**
 * schemas/collections/clients.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Document schemas for the CRM core: clients and their subcollections.
 */
import type {
  Charge,
  ClientNote,
  Extensible,
  IsoTimestamp,
  JourneyStep,
  PendingAction,
  Quote,
  StageRating,
  StatusComment,
} from "../types.ts";

/** A single consultation record (the latest is the "current" intake). */
export interface ConsultationDoc extends Extensible {
  name?: string;
  surname?: string;
  email?: string;
  phone?: string;
  legalArea?: string;
  legalMatter?: string;
  jurisdiction?: string;
  documents?: string[];
  notes?: string;
  serviceType?: string;
  createdAt?: IsoTimestamp;
  updatedAt?: IsoTimestamp;
}

/** clients — the canonical client document (CRM core). */
export interface ClientDoc extends Extensible {
  id: string;
  email: string;
  stage: string;
  stageEnteredAt?: IsoTimestamp;
  clientFields: Record<string, unknown>;
  consultations: ConsultationDoc[];
  journey: JourneyStep[];
  stageRatings: StageRating[];
  charges: Charge[];
  quotes: Quote[];
  notes: ClientNote[];
  pendingActions: PendingAction[];
  conversations: string[];
  statusChatThread?: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** clients/{id}/pricing_requests — a pricing request subdocument. */
export interface PricingRequestDoc extends Extensible {
  id: string;
  index: number;
  options: unknown[];
  status?: string;
  inferredAreaLabel?: string;
  expectedMarginPct?: number;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** client_conversations — a conversation thread linked to a client. */
export interface ClientConversationDoc extends Extensible {
  id: string;
  clientId: string;
  messages: unknown[];
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** status_chat_threads — a status-page chat thread. */
export interface StatusChatThreadDoc extends Extensible {
  id: string;
  clientId: string;
  comments: StatusComment[];
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}