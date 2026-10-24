/**
 * schemas/index.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Central schema registry. Maps every Firestore collection name to its
 * document type and provides the placeholder factory for each configuration.
 *
 * This is the single source of truth for the ILP data model. Routers, jobs,
 * and the dashboard import types from here instead of inlining shapes.
 */
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
  UserDeadline,
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

/**
 * The complete map of collection name → document type. Every collection in
 * `db/collections.ts` plus the ad-hoc collections used across routers is
 * represented here.
 */
export interface SchemaMap {
  // Auth / sessions
  dashboard_sessions: DashboardSession;
  dashboard_otps: DashboardOtp;
  client_status_sessions: ClientStatusSession;
  client_status_otps: ClientStatusOtp;

  // Clients (CRM core)
  clients: ClientDoc;
  client_conversations: ClientConversationDoc;
  status_chat_threads: StatusChatThreadDoc;
  consultations: ConsultationBookingDoc;

  // Pipeline / stage config
  stage_config: StageConfigDoc;
  stage_gates: StageGateDoc;
  stage_gate_rules: StageGateRuleDoc;
  overview_fields: OverviewFieldDoc;

  // Quotes
  quote_templates: QuoteTemplateDoc;
  quote_line_templates: QuoteLineTemplateDoc;
  quote_labels: QuoteLabelDoc;
  quote_template_map: QuoteTemplateMapDoc;
  quote_service_types: QuoteServiceTypeDoc;

  // Email / automation
  email_queue: EmailQueueDoc;
  email_templates: EmailTemplateDoc;
  stage_email_rules: StageEmailRuleDoc;
  email_recipient_rules: EmailRecipientRuleDoc;
  automation_rules: AutomationRuleDoc;
  action_registry: ActionRegistryDoc;

  // LLM / analytics
  llm_costs: LlmCostDoc;
  evo_assignments: EvoAssignmentDoc;
  evo_exposures: EvoExposureDoc;
  evo_interactions: EvoInteractionDoc;
  metrics: MetricsDoc;

  // Content
  posts: PostDoc;
  updates: UpdateDoc;
  templates: TemplateDoc;
  template_downloads: TemplateDownloadDoc;

  // People / entities
  providers: ProviderDoc;
  provider_field_schema: ProviderFieldSchemaDoc;
  profiles: ProfileDoc;
  vendors: VendorDoc;
  leads: LeadDoc;

  // Ops
  tasks: TaskDoc;
  alerts: AlertDoc;
  rules: RuleDoc;
  audit_log: AuditLogDoc;
  cronState: CronStateDoc;
  bug_reports: BugReportDoc;
  ilp_chatbot_threads: ChatbotThreadDoc;
  invoices: InvoiceDoc;

  // Dashboard config (fixed-id docs)
  dashboard_config: Record<string, unknown>;
  configurations: Record<string, unknown>;
}

/** A collection name keyed by the schema map. */
export type SchemaCollectionName = keyof SchemaMap;

/** The document type for a given collection name. */
export type DocOf<K extends SchemaCollectionName> = SchemaMap[K];

export type {
  DashboardOtp,
  DashboardSession,
  ClientStatusOtp,
  ClientStatusSession,
  ClientDoc,
  ClientConversationDoc,
  ConsultationDoc,
  PricingRequestDoc,
  StatusChatThreadDoc,
  OverviewFieldDoc,
  StageConfigDoc,
  StageGateDoc,
  StageGateRuleDoc,
  QuoteLabelDoc,
  QuoteLineTemplateDoc,
  QuoteServiceTypeDoc,
  QuoteTemplateDoc,
  QuoteTemplateMapDoc,
  ActionRegistryDoc,
  AutomationRuleDoc,
  EmailQueueDoc,
  EmailRecipientRuleDoc,
  EmailTemplateDoc,
  StageEmailRuleDoc,
  EvoAssignmentDoc,
  EvoExposureDoc,
  EvoInteractionDoc,
  LlmCostDoc,
  MetricsDoc,
  PostDoc,
  TemplateDoc,
  TemplateDownloadDoc,
  UpdateDoc,
  ConsultationBookingDoc,
  LeadDoc,
  ProfileDoc,
  UserDeadline,
  ProviderDoc,
  ProviderFieldSchemaDoc,
  VendorDoc,
  AlertDoc,
  AuditLogDoc,
  BugReportDoc,
  ChatbotThreadDoc,
  CronStateDoc,
  InvoiceDoc,
  RuleDoc,
  TaskDoc,
  AccessConfigDoc,
  ActionPermissionsDoc,
  BankInfoConfigDoc,
  ClientOfferPopupConfigDoc,
  CollaboratorsDoc,
  ContractRecipientsConfigDoc,
  QuoteApproversConfigDoc,
  QuoteTemplateMapConfigDoc,
};

export * from "./types.ts";