/**
 * schemas/collections/automation.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Document schemas for email/automation collections.
 */
import type { Extensible, IsoTimestamp } from "../types.ts";

/** email_queue — a queued outbound email. */
export interface EmailQueueDoc extends Extensible {
  id: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  cc?: string[];
  bcc?: string[];
  attachments?: Array<{
    filename: string;
    content: string;
    contentType?: string;
  }>;
  status: "pending" | "sent" | "dead" | "cancelled";
  attempts: number;
  sentAt?: IsoTimestamp;
  cancelledAt?: IsoTimestamp;
  lastError?: string | null;
  nextAttemptAt?: IsoTimestamp | null;
  createdAt: IsoTimestamp;
}

/** email_templates — an email template. */
export interface EmailTemplateDoc extends Extensible {
  id: string;
  emailType: string;
  subject: string;
  body: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** stage_email_rules — a stage-triggered email rule. */
export interface StageEmailRuleDoc extends Extensible {
  id: string;
  triggerStage: string;
  emailType: string;
  condition: "always" | "has_email" | "no_email";
  mode: "auto" | "suggest";
  enabled: boolean;
  delayHours: number;
  label: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  updatedBy?: string;
}

/** email_recipient_rules — a recipient routing rule. */
export interface EmailRecipientRuleDoc extends Extensible {
  id: string;
  stage?: string;
  recipients: string[];
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** automation_rules — a generic automation rule. */
export interface AutomationRuleDoc extends Extensible {
  id: string;
  trigger: string;
  action: string;
  enabled: boolean;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** action_registry — a registered action definition. */
export interface ActionRegistryDoc extends Extensible {
  id: string;
  key: string;
  label: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}