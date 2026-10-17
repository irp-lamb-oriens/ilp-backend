/**
 * db/collections.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Canonical Firestore collection names for the ILP platform.
 *
 * Centralizing these prevents typos and makes the data model auditable in one
 * place. The `db/*.ts` wrappers (get/put/post/patch/query/getAll/delete) take a
 * collection string; call sites should reference these constants instead of
 * inlining a string literal.
 *
 * Ported from IRP-funnel's collection set, retargeted to ILP's legal taxonomy.
 */

export const COLLECTIONS = {
  // ── Auth / sessions ─────────────────────────────────────────────────────
  dashboardSessions: "dashboard_sessions",
  dashboardOtps: "dashboard_otps",
  clientStatusSessions: "client_status_sessions",
  clientStatusOtps: "client_status_otps",

  // ── Clients (the CRM core) ──────────────────────────────────────────────
  clients: "clients",
  clientConversations: "client_conversations",
  statusChatThreads: "status_chat_threads",

  // ── Pipeline / stage config ─────────────────────────────────────────────
  stageConfig: "stage_config",
  stageGates: "stage_gates",
  overviewFields: "overview_fields",

  // ── Quotes ──────────────────────────────────────────────────────────────
  quoteTemplates: "quote_templates",
  quoteLineTemplates: "quote_line_templates",
  quoteLabels: "quote_labels",
  quoteTemplateMap: "quote_template_map",
  quoteServiceTypes: "quote_service_types",

  // ── Email / automation ──────────────────────────────────────────────────
  emailQueue: "email_queue",
  emailTemplates: "email_templates",
  automationRules: "automation_rules",
  actionRegistry: "action_registry",

  // ── LLM / analytics ─────────────────────────────────────────────────────
  llmCosts: "llm_costs",
  evoAssignments: "evo_assignments",
  evoExposures: "evo_exposures",
  evoInteractions: "evo_interactions",

  // ── Config sentinels ────────────────────────────────────────────────────
  configurations: "configurations",
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];