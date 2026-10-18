/**
 * ILP — Legal Assistant shared agent types.
 */

export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface ConversationTurn {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  createdAt: string;
}

export interface ConversationContext {
  conversationId: string;
  customerId?: string;
  turns: ConversationTurn[];
  extractedFields: Record<string, unknown>;
}

export interface AgentResult {
  ok: boolean;
  output?: string;
  error?: string;
}

export interface AvailabilitySlot {
  start: string;
  end: string;
}

export interface SchedulingRequest {
  conversationId: string;
  customerId?: string;
  requestedSlot?: AvailabilitySlot;
  serviceType?: string;
}

export interface SchedulingResult {
  ok: boolean;
  eventId?: string;
  error?: string;
}

// ── Agent response types (ported from IRP, retargeted to ILP legal services) ──

export interface ConversationalAgentResponse {
  responseText: string;
  responseHTML: string;
  extractedFields?: Record<string, unknown>;
}

export interface ThinkingAgentResponse {
  decision: string;
  responseIntent: string;
  userIntent:
    | "answer"
    | "answer_with_uncertainty"
    | "skip"
    | "frustration"
    | "off_topic"
    | "greeting"
    | "correction"
    | "scheduling_request";
  fieldToSkip?: string;
  whatToSay: string[];
  whatToAvoid: string[];
  needsAvailabilityCheck?: boolean;
  needsScheduling?: boolean;
  proactiveScheduling?: boolean;
}

export interface AvailabilityAgentResponse {
  availabilityRequested: boolean;
  NON_TAKEN_MEETING_TIME_RANGES: string[];
  formattedAvailableSlots?: string[];
  missingFields: string[];
  collisionDetected: boolean;
  slotConfirmedAvailable?: boolean;
  schedulingPolicies?: string[];
}

export interface SchedulerAgentResponse {
  canSchedule: boolean;
  calendarAction: "create_event" | "reject_slot" | "none";
  eventPayload: unknown;
  schedulerResult: string;
  schedulerMessage: string;
  createdEvent?: {
    id: string;
    htmlLink: string;
    hangoutLink: string;
    summary: string;
    start: string;
    end: string;
  };
  alternativeSlots?: string[];
}

export interface HallucinationDetectorAgentResponse {
  hallucinationsDetected: boolean;
  severity: "none" | "low" | "medium" | "high";
  detectedPatterns: string[];
  verbatimClaims: string[];
  reasoning: string;
}

export interface ModeratorAgentResponse {
  blocked: boolean;
  reason: "toxicity" | "promptInjection" | "legalAdvice" | "offTopic" | "none";
  severity: "none" | "low" | "medium" | "high" | "critical";
  explanation: string;
}

/** Slim ground-truth store for the hallucination detector (ILP legal intake). */
export interface ChatbotGroundTruth {
  availability?: AvailabilityAgentResponse;
  scheduler?: SchedulerAgentResponse;
}

// ── R3 agent response types ─────────────────────────────────────────────────

/** Knowledge-base (librarian) answer to a service/jurisdiction/stage question. */
export interface LibrarianAgentResponse {
  answered: boolean;
  answer: string;
  source: "context_information" | "context_sales" | "none";
  matchedKeywords: string[];
}

/** LLM-generated conversation/thread summary. */
export interface SummarizationAgentResponse {
  summary: string;
  messageCount: number;
}

/** Duplicate-intent/field check result. */
export interface DeduplicationAgentResponse {
  isDuplicate: boolean;
  duplicateFields: string[];
  changedFields: Record<string, { before: unknown; after: unknown }>;
}

/** Merged reply from parallel agent outputs. */
export interface AggregatorAgentResponse {
  mergedReply: string;
  sources: string[];
}

/** Sales intent routing branch (quote/booking). */
export interface SalesAgentResponse {
  intent: "quote" | "booking" | "general";
  confidenceGuestimate: number;
  reply: string;
}

/** Support intent routing branch (issue classification). */
export interface SupportAgentResponse {
  intent: "document" | "deadline" | "payment" | "status" | "other";
  reply: string;
}

/** Proactive follow-up nudges from pending actions. */
export interface ActivatorAgentResponse {
  shouldNudge: boolean;
  nudge: string;
  resolvedActionIds: string[];
}

/** Task-status answer from the tasks collection. */
export interface TaskProgressAgentResponse {
  found: boolean;
  statusText: string;
  taskId: string | null;
}

/** Escalation to staff as pending action + optional email. */
export interface LegalOpsNotifierAgentResponse {
  escalated: boolean;
  pendingActionId: string | null;
  emailQueued: boolean;
}
