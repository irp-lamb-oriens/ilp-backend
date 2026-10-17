/**
 * API/dashboard/automation/stageDefaults.ts
 * ──────────────────────────────────────────────────────────────────────────
 * The SINGLE hardcoded fallback + seed for the ILP pipeline stage config.
 *
 * Ported from IRP-funnel's `stageDefaults.ts`, retargeted to ILP's legal
 * taxonomy. The IRP relocation pipeline (sales → packing → shipping → customs)
 * is replaced with a legal-matter pipeline:
 *
 *   intake → scoping → legal_review → quote_sent → quote_accepted → filing → closed
 *
 * Every stage is just a row. Operators add / rename / reorder / hide / delete
 * rows from the dashboard; the same modular `stageStore` functions are reused.
 */

/** Coarse grouping used purely for display/organisation in the config UI. */
export type StagePhase = "sales" | "legal_work" | "completion";

export type StageNotifyGroup = "sales" | "legal" | "ops";

/**
 * One pipeline stage / Kanban column. Stored one-per-doc in `stage_config`
 * (doc id === `id`).
 */
export interface StageDef {
  id: string;
  label: string;
  order: number;
  description: string;
  icon: string;
  color: string;
  /** "Stuck client" SLA threshold in days. `null` ⇒ no SLA. */
  slaDays: number | null;
  phase: StagePhase;
  notifyGroup: StageNotifyGroup;
  /** When true, the client status page NEVER shows this stage. */
  hiddenFromClient: boolean;
  clientLabel?: string;
  active: boolean;
  isSeed?: boolean;
  updatedBy?: string;
  updatedAt?: string;
  createdAt?: string;
}

const STAGE_ICONS: Record<string, string> = {
  intake: "📥",
  scoping: "🔍",
  legal_review: "⚖️",
  quote_sent: "📋",
  quote_accepted: "✅",
  filing: "📑",
  closed: "🏁",
};

const STAGE_COLORS: Record<string, string> = {
  intake: "#6366f1",
  scoping: "#818cf8",
  legal_review: "#8b5cf6",
  quote_sent: "#9333ea",
  quote_accepted: "#7c3aed",
  filing: "#0ea5e9",
  closed: "#059669",
};

const STAGE_SLA_DAYS: Record<string, number> = {
  scoping: 3,
  legal_review: 5,
  quote_sent: 3,
  quote_accepted: 2,
  filing: 7,
};

const STAGE_PHASE: Record<string, StagePhase> = {
  intake: "sales",
  scoping: "sales",
  legal_review: "legal_work",
  quote_sent: "sales",
  quote_accepted: "sales",
  filing: "legal_work",
  closed: "completion",
};

const STAGE_NOTIFY: Record<string, StageNotifyGroup> = {
  intake: "sales",
  scoping: "sales",
  legal_review: "legal",
  quote_sent: "sales",
  quote_accepted: "sales",
  filing: "legal",
  closed: "ops",
};

/** Stages hidden from the client status page. */
const INACTIVE_STAGES = new Set<string>([]);

/** Stages the client never sees (internal only). */
const HIDDEN_FROM_CLIENT = new Set<string>(["intake"]);

export const PIPELINE_STAGES = [
  "intake",
  "scoping",
  "legal_review",
  "quote_sent",
  "quote_accepted",
  "filing",
  "closed",
] as const;

export const STAGE_LABELS: Record<string, string> = {
  intake: "Intake",
  scoping: "Scoping",
  legal_review: "Legal Review",
  quote_sent: "Quote Sent",
  quote_accepted: "Quote Accepted",
  filing: "Filing",
  closed: "Closed",
};

export const STAGE_DESCRIPTIONS: Record<string, string> = {
  intake: "Lead captured — intake form submitted, awaiting scoping.",
  scoping: "Determining the legal matter, jurisdiction, and required documents.",
  legal_review: "Attorney reviewing the matter and preparing the engagement.",
  quote_sent: "Quote sent to the client — awaiting their review.",
  quote_accepted: "Client accepted the quote — preparing for filing.",
  filing: "Filing / legal work in progress.",
  closed: "Matter fully completed and closed.",
};

export const HARDCODED_STAGE_DEFS: StageDef[] = PIPELINE_STAGES.map(
  (id, index): StageDef => ({
    id,
    label: STAGE_LABELS[id] ?? id,
    order: index,
    description: STAGE_DESCRIPTIONS[id] ?? "",
    icon: STAGE_ICONS[id] ?? "📌",
    color: STAGE_COLORS[id] ?? "#64748b",
    slaDays: STAGE_SLA_DAYS[id] ?? null,
    phase: STAGE_PHASE[id] ?? "sales",
    notifyGroup: STAGE_NOTIFY[id] ?? "sales",
    hiddenFromClient: HIDDEN_FROM_CLIENT.has(id),
    active: !INACTIVE_STAGES.has(id),
    isSeed: true,
  }),
);

export const HARDCODED_STAGE_MAP: ReadonlyMap<string, StageDef> = new Map(
  HARDCODED_STAGE_DEFS.map((s) => [s.id, s]),
);

export function normalizeStageDef(
  row: Record<string, unknown>,
  fallbackOrder = 0,
): StageDef {
  const id = String(row?.id ?? "").trim();
  const base = HARDCODED_STAGE_MAP.get(id);
  const num = (v: unknown, d: number): number =>
    Number.isFinite(+(v as number)) ? +(v as number) : d;
  return {
    id,
    label: typeof row?.label === "string" && row.label ? row.label : base?.label ?? id,
    order: num(row?.order, base?.order ?? fallbackOrder),
    description: typeof row?.description === "string" ? row.description : base?.description ?? "",
    icon: typeof row?.icon === "string" && row.icon ? row.icon : base?.icon ?? "📌",
    color: typeof row?.color === "string" && row.color ? row.color : base?.color ?? "#64748b",
    slaDays:
      row?.slaDays === null || row?.slaDays === undefined
        ? base?.slaDays ?? null
        : num(row.slaDays, base?.slaDays ?? 0),
    phase: (row?.phase as StagePhase) ?? base?.phase ?? "sales",
    notifyGroup: (row?.notifyGroup as StageNotifyGroup) ?? base?.notifyGroup ?? "sales",
    hiddenFromClient:
      typeof row?.hiddenFromClient === "boolean"
        ? row.hiddenFromClient
        : base?.hiddenFromClient ?? false,
    clientLabel: typeof row?.clientLabel === "string" ? row.clientLabel : base?.clientLabel,
    active: row?.active === false ? false : row?.active === true ? true : base?.active ?? true,
    isSeed: row?.isSeed === true,
    updatedBy: typeof row?.updatedBy === "string" ? row.updatedBy : undefined,
    updatedAt: typeof row?.updatedAt === "string" ? row.updatedAt : undefined,
    createdAt: typeof row?.createdAt === "string" ? row.createdAt : undefined,
  };
}