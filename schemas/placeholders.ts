/**
 * schemas/placeholders.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Placeholder document factories. Each function returns a fully-formed,
 * default-valued document for its collection, so any code path can obtain a
 * valid starting shape without hand-rolling field defaults.
 *
 * These are the "all configurations of possible documents" — one factory per
 * collection, plus fixed-id config placeholders for `dashboard_config`.
 *
 * Every factory stamps `isPlaceholder: true` so seeded/placeholder documents
 * are self-identifying and can be swept or filtered later.
 */
import type { IsoTimestamp } from "./types.ts";
import type {
  DashboardOtp,
  DashboardSession,
  ClientStatusOtp,
  ClientStatusSession,
} from "./collections/auth.ts";
import type {
  ClientDoc,
  ClientConversationDoc,
  ConsultationDoc,
  PricingRequestDoc,
  StatusChatThreadDoc,
} from "./collections/clients.ts";
import type {
  OverviewFieldDoc,
  StageConfigDoc,
  StageGateDoc,
  StageGateRuleDoc,
} from "./collections/pipeline.ts";
import type {
  QuoteLabelDoc,
  QuoteLineTemplateDoc,
  QuoteServiceTypeDoc,
  QuoteTemplateDoc,
  QuoteTemplateMapDoc,
} from "./collections/quotes.ts";
import type {
  ActionRegistryDoc,
  AutomationRuleDoc,
  EmailQueueDoc,
  EmailRecipientRuleDoc,
  EmailTemplateDoc,
  StageEmailRuleDoc,
} from "./collections/automation.ts";
import type {
  EvoAssignmentDoc,
  EvoExposureDoc,
  EvoInteractionDoc,
  LlmCostDoc,
  MetricsDoc,
} from "./collections/analytics.ts";
import type {
  PostDoc,
  TemplateDoc,
  TemplateDownloadDoc,
  UpdateDoc,
} from "./collections/content.ts";
import type {
  ConsultationBookingDoc,
  LeadDoc,
  ProfileDoc,
  ProviderDoc,
  ProviderFieldSchemaDoc,
  VendorDoc,
} from "./collections/people.ts";
import type {
  AlertDoc,
  AuditLogDoc,
  BugReportDoc,
  ChatbotThreadDoc,
  CronStateDoc,
  InvoiceDoc,
  RuleDoc,
  TaskDoc,
} from "./collections/ops.ts";
import type {
  AccessConfigDoc,
  ActionPermissionsDoc,
  BankInfoConfigDoc,
  ClientOfferPopupConfigDoc,
  CollaboratorsDoc,
  ContractRecipientsConfigDoc,
  QuoteApproversConfigDoc,
  QuoteTemplateMapConfigDoc,
} from "./collections/dashboardConfig.ts";

const now = (): IsoTimestamp => new Date().toISOString();

// ── Auth / sessions ────────────────────────────────────────────────────────

export function dashboardSessionPlaceholder(
  email = "",
): DashboardSession {
  return { email, createdAt: now(), expiresAt: now(), isPlaceholder: true };
}

export function dashboardOtpPlaceholder(email = ""): DashboardOtp {
  return { code: "", email, createdAt: now(), expiresAt: now(), isPlaceholder: true };
}

export function clientStatusSessionPlaceholder(
  email = "",
): ClientStatusSession {
  return { email, createdAt: now(), expiresAt: now(), isPlaceholder: true };
}

export function clientStatusOtpPlaceholder(email = ""): ClientStatusOtp {
  return { code: "", email, createdAt: now(), expiresAt: now(), isPlaceholder: true };
}

// ── Clients (CRM core) ─────────────────────────────────────────────────────

export function clientPlaceholder(id = "", email = ""): ClientDoc {
  return {
    id,
    email,
    stage: "",
    clientFields: {},
    consultations: [],
    journey: [],
    stageRatings: [],
    charges: [],
    quotes: [],
    notes: [],
    pendingActions: [],
    conversations: [],
    createdAt: now(),
    updatedAt: now(),
    isPlaceholder: true,
  };
}

export function consultationPlaceholder(): ConsultationDoc {
  return { createdAt: now(), updatedAt: now(), isPlaceholder: true };
}

export function pricingRequestPlaceholder(
  id = "",
  index = 0,
): PricingRequestDoc {
  return {
    id,
    index,
    options: [],
    createdAt: now(),
    updatedAt: now(),
    isPlaceholder: true,
  };
}

export function clientConversationPlaceholder(
  id = "",
  clientId = "",
): ClientConversationDoc {
  return { id, clientId, messages: [], createdAt: now(), updatedAt: now(), isPlaceholder: true };
}

export function statusChatThreadPlaceholder(
  id = "",
  clientId = "",
): StatusChatThreadDoc {
  return { id, clientId, comments: [], createdAt: now(), updatedAt: now(), isPlaceholder: true };
}

// ── Pipeline / stage config ────────────────────────────────────────────────

export function stageConfigPlaceholder(
  id = "",
  key = "",
  label = "",
  order = 0,
): StageConfigDoc {
  return { id, key, label, order, createdAt: now(), updatedAt: now(), isPlaceholder: true };
}

export function stageGatePlaceholder(
  id = "",
  stage = "",
  gate = "",
): StageGateDoc {
  return { id, stage, gate, enabled: true, createdAt: now(), updatedAt: now(), isPlaceholder: true };
}

export function stageGateRulePlaceholder(
  id = "",
  stage = "",
  gate = "",
): StageGateRuleDoc {
  return { id, stage, gate, enabled: true, createdAt: now(), updatedAt: now(), isPlaceholder: true };
}

export function overviewFieldPlaceholder(
  id = "",
  key = "",
  label = "",
): OverviewFieldDoc {
  return { id, key, label, createdAt: now(), updatedAt: now(), isPlaceholder: true };
}

// ── Quotes ─────────────────────────────────────────────────────────────────

export function quoteTemplatePlaceholder(
  id = "",
  title = "",
): QuoteTemplateDoc {
  return { id, title, blocks: [], createdAt: now(), updatedAt: now(), isPlaceholder: true };
}

export function quoteLineTemplatePlaceholder(
  id = "",
  label = "",
): QuoteLineTemplateDoc {
  return { id, label, createdAt: now(), updatedAt: now(), isPlaceholder: true };
}

export function quoteLabelPlaceholder(id = "", label = ""): QuoteLabelDoc {
  return { id, label, createdAt: now(), updatedAt: now(), isPlaceholder: true };
}

export function quoteServiceTypePlaceholder(
  id = "",
  label = "",
): QuoteServiceTypeDoc {
  return { id, label, createdAt: now(), updatedAt: now(), isPlaceholder: true };
}

export function quoteTemplateMapPlaceholder(
  id = "",
): QuoteTemplateMapDoc {
  return { id, map: {}, createdAt: now(), updatedAt: now(), isPlaceholder: true };
}

// ── Email / automation ─────────────────────────────────────────────────────

export function emailQueuePlaceholder(
  id = "",
  to = "",
  subject = "",
  html = "",
): EmailQueueDoc {
  return {
    id,
    to,
    subject,
    html,
    status: "pending",
    attempts: 0,
    createdAt: now(),
    isPlaceholder: true,
  };
}

export function emailTemplatePlaceholder(
  id = "",
  emailType = "",
): EmailTemplateDoc {
  return {
    id,
    emailType,
    subject: "",
    body: "",
    createdAt: now(),
    updatedAt: now(),
    isPlaceholder: true,
  };
}

export function stageEmailRulePlaceholder(
  id = "",
  triggerStage = "",
  emailType = "",
): StageEmailRuleDoc {
  return {
    id,
    triggerStage,
    emailType,
    condition: "always",
    mode: "suggest",
    enabled: true,
    delayHours: 0,
    label: `${triggerStage} → ${emailType}`,
    createdAt: now(),
    updatedAt: now(),
    isPlaceholder: true,
  };
}

export function emailRecipientRulePlaceholder(
  id = "",
): EmailRecipientRuleDoc {
  return { id, recipients: [], createdAt: now(), updatedAt: now(), isPlaceholder: true };
}

export function automationRulePlaceholder(
  id = "",
  trigger = "",
  action = "",
): AutomationRuleDoc {
  return { id, trigger, action, enabled: true, createdAt: now(), updatedAt: now(), isPlaceholder: true };
}

export function actionRegistryPlaceholder(
  id = "",
  key = "",
  label = "",
): ActionRegistryDoc {
  return { id, key, label, createdAt: now(), updatedAt: now(), isPlaceholder: true };
}

// ── LLM / analytics ────────────────────────────────────────────────────────

export function llmCostPlaceholder(id = "", costUSD = 0): LlmCostDoc {
  return { id, costUSD, createdAt: now(), isPlaceholder: true };
}

export function evoAssignmentPlaceholder(id = ""): EvoAssignmentDoc {
  return { id, createdAt: now(), updatedAt: now(), isPlaceholder: true };
}

export function evoExposurePlaceholder(id = ""): EvoExposureDoc {
  return { id, createdAt: now(), updatedAt: now(), isPlaceholder: true };
}

export function evoInteractionPlaceholder(id = ""): EvoInteractionDoc {
  return { id, createdAt: now(), updatedAt: now(), isPlaceholder: true };
}

export function metricsPlaceholder(id = ""): MetricsDoc {
  return { id, isPlaceholder: true };
}

// ── Content ────────────────────────────────────────────────────────────────

export function postPlaceholder(
  id = "",
  slug = "",
  title = "",
): PostDoc {
  return {
    id,
    kind: "post",
    slug,
    title,
    createdAt: now(),
    updatedAt: now(),
    isPlaceholder: true,
  };
}

export function updatePlaceholder(id = "", title = ""): UpdateDoc {
  return { id, title, createdAt: now(), updatedAt: now(), isPlaceholder: true };
}

export function templatePlaceholder(id = "", title = ""): TemplateDoc {
  return { id, title, createdAt: now(), updatedAt: now(), isPlaceholder: true };
}

export function templateDownloadPlaceholder(
  id = "",
  templateId = "",
): TemplateDownloadDoc {
  return { id, templateId, createdAt: now(), isPlaceholder: true };
}

// ── People / entities ──────────────────────────────────────────────────────

export function providerPlaceholder(id = ""): ProviderDoc {
  return { id, status: "pending", createdAt: now(), updatedAt: now(), isPlaceholder: true };
}

export function providerFieldSchemaPlaceholder(
  id = "global",
): ProviderFieldSchemaDoc {
  return { id, knownFields: [], isPlaceholder: true };
}

export function profilePlaceholder(id = ""): ProfileDoc {
  return { id, createdAt: now(), updatedAt: now(), isPlaceholder: true };
}

export function vendorPlaceholder(id = ""): VendorDoc {
  return { id, createdAt: now(), updatedAt: now(), isPlaceholder: true };
}

export function leadPlaceholder(id = "", email = ""): LeadDoc {
  return { id, email, createdAt: now(), isPlaceholder: true };
}

export function consultationBookingPlaceholder(
  id = "",
  customerId = "",
  providerId = "",
): ConsultationBookingDoc {
  return {
    id,
    customerId,
    providerId,
    slot: { start: "", end: "", timezone: "UTC" },
    status: "requested",
    createdAt: now(),
    updatedAt: now(),
    isPlaceholder: true,
  };
}

// ── Ops ────────────────────────────────────────────────────────────────────

export function taskPlaceholder(id = ""): TaskDoc {
  return { id, createdAt: now(), updatedAt: now(), isPlaceholder: true };
}

export function alertPlaceholder(id = ""): AlertDoc {
  return { id, status: "scheduled", createdAt: now(), updatedAt: now(), isPlaceholder: true };
}

export function rulePlaceholder(id = ""): RuleDoc {
  return { id, createdAt: now(), updatedAt: now(), isPlaceholder: true };
}

export function auditLogPlaceholder(id = ""): AuditLogDoc {
  return { id, at: now(), isPlaceholder: true };
}

export function cronStatePlaceholder(id = ""): CronStateDoc {
  return { id, lastRanAt: now(), isPlaceholder: true };
}

export function bugReportPlaceholder(id = ""): BugReportDoc {
  return { id, createdAt: now(), isPlaceholder: true };
}

export function chatbotThreadPlaceholder(
  id = "",
  clientId = "",
): ChatbotThreadDoc {
  return { id, clientId, messages: [], createdAt: now(), updatedAt: now(), isPlaceholder: true };
}

export function invoicePlaceholder(id = ""): InvoiceDoc {
  return { id, createdAt: now(), updatedAt: now(), isPlaceholder: true };
}

// ── Dashboard config (fixed-id docs) ───────────────────────────────────────

export function quoteApproversConfigPlaceholder(): QuoteApproversConfigDoc {
  return { id: "quote_approvers", approvers: [], updatedAt: now(), isPlaceholder: true };
}

export function clientOfferPopupConfigPlaceholder(): ClientOfferPopupConfigDoc {
  return { id: "client_offer_popup", enabled: false, updatedAt: now(), isPlaceholder: true };
}

export function contractRecipientsConfigPlaceholder(): ContractRecipientsConfigDoc {
  return { id: "contract_recipients", recipients: [], updatedAt: now(), isPlaceholder: true };
}

export function bankInfoConfigPlaceholder(): BankInfoConfigDoc {
  return { id: "bank_info", updatedAt: now(), isPlaceholder: true };
}

export function accessConfigPlaceholder(): AccessConfigDoc {
  return { id: "access_config", views: {}, collaborators: [], updatedAt: now(), isPlaceholder: true };
}

export function actionPermissionsPlaceholder(): ActionPermissionsDoc {
  return { id: "action_permissions", permissions: {}, updatedAt: now(), isPlaceholder: true };
}

export function collaboratorsPlaceholder(): CollaboratorsDoc {
  return { id: "collaborators", collaborators: [], updatedAt: now(), isPlaceholder: true };
}

export function quoteTemplateMapConfigPlaceholder(): QuoteTemplateMapConfigDoc {
  return { id: "quoteTemplateMap", map: {}, updatedAt: now(), isPlaceholder: true };
}