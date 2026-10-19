/**
 * schemas/collections/ops.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Document schemas for operational collections (tasks, alerts, rules,
 * audit log, cron state, bug reports, chatbot threads, finance).
 */
import type { Extensible, IsoTimestamp } from "../types.ts";

/** tasks — a task record. */
export interface TaskDoc extends Extensible {
  id: string;
  type?: string;
  title?: string;
  status?: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** alerts — a compliance alert. */
export interface AlertDoc extends Extensible {
  id: string;
  title?: string;
  description?: string;
  country?: string;
  category?: string;
  deadlineLabel?: string;
  deadlineTs?: number;
  status?: "scheduled" | "dispatched" | "responded" | "needs_help";
  profileId?: string;
  taskId?: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** rules — a rule record. */
export interface RuleDoc extends Extensible {
  id: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** audit_log — an audit log entry. */
export interface AuditLogDoc extends Extensible {
  id: string;
  at: IsoTimestamp;
  [key: string]: unknown;
}

/** cronState — a cron job state record. */
export interface CronStateDoc extends Extensible {
  id: string;
  lastRanAt: IsoTimestamp;
}

/** bug_reports — a bug report. */
export interface BugReportDoc extends Extensible {
  id: string;
  createdAt: IsoTimestamp;
}

/** ilp_chatbot_threads — a chatbot conversation thread. */
export interface ChatbotThreadDoc extends Extensible {
  id: string;
  clientId?: string;
  messages: unknown[];
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** invoices — an invoice record. */
export interface InvoiceDoc extends Extensible {
  id: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}