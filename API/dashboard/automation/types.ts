/**
 * API/dashboard/automation/types.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Shared types for the ILP email-template override engine.
 *
 * Ported from IRP-funnel's `API/dashboard/automation/types.ts`, trimmed to the
 * template-override surface (the stage-email-rule engine is a later phase).
 *
 * `email_templates` holds editable OVERRIDES of the otherwise hardcoded
 * transactional templates (helper/emailTemplates.ts): subject + body + on/off.
 * A missing or disabled override means the hardcoded template is used, so this
 * is fully backward compatible.
 */

/**
 * Editable override for one email type. Stored one-per-doc in `email_templates`,
 * doc id === `emailType`. When `enabled` is false OR the doc is absent, the
 * hardcoded template is used instead.
 *
 * `bodyHtml` may contain `{{placeholder}}` tokens that are interpolated from the
 * client data dict at render time (field-agnostic — any field on the doc).
 */
export interface EmailTemplateOverride {
  /** Doc id === email type key. */
  emailType: string;
  subject: string;
  /** Full HTML body; supports `{{field}}` interpolation. */
  bodyHtml: string;
  label: string;
  category: "sales" | "ops" | "followup";
  /** When false, fall back to the hardcoded template. */
  enabled: boolean;
  /** True when there is NO hardcoded fallback (a brand-new operator template). */
  isCustom: boolean;
  updatedBy?: string;
  updatedAt?: string;
  createdAt?: string;
}

// ── Stage Email Automation rules ─────────────────────────────────────────────

/** When a rule fires relative to the stage move. */
export type RuleCondition = "always" | "has_email" | "no_email";

/** Whether the rule auto-sends or only suggests an email. */
export type RuleMode = "auto" | "suggest";

export const RULE_CONDITIONS: RuleCondition[] = ["always", "has_email", "no_email"];

export const RULE_MODES: RuleMode[] = ["auto", "suggest"];

/**
 * A stage-email automation rule. Stored one-per-doc in `stage_email_rules`
 * (doc id === rule.id). When a client moves INTO `triggerStage`, the rule
 * decides whether `emailType` fires automatically or is surfaced as a
 * suggestion, gated by `condition`.
 */
export interface StageEmailRule {
  /** Stable doc id (defaults to `${triggerStage}__${emailType}`). */
  id: string;
  /** The stage a client is moving INTO that triggers this rule. */
  triggerStage: string;
  /** The email type to fire / suggest. */
  emailType: string;
  /** When the rule applies. */
  condition: RuleCondition;
  /** Auto-send vs. operator suggestion. */
  mode: RuleMode;
  /** Master on/off. */
  enabled: boolean;
  /** Delay in hours before the email is eligible to send. */
  delayHours: number;
  /** Human label for the editor UI. */
  label: string;
  updatedBy?: string;
  updatedAt?: string;
  createdAt?: string;
}
