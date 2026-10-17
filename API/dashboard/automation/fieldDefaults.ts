/**
 * API/dashboard/automation/fieldDefaults.ts
 * ──────────────────────────────────────────────────────────────────────────
 * The SINGLE hardcoded fallback + seed for the ILP "Overview Field Registry".
 *
 * Ported from IRP-funnel's `fieldDefaults.ts`, retargeted to ILP's legal
 * taxonomy. The relocation fields (route, vehicles, packing) are replaced with
 * legal-intake fields (legal area, jurisdiction, documents, matter type).
 *
 * This registry is ADVISORY / additive, never enforcing. It answers one
 * question for the client card's Overview tab and the import checker: which
 * fields should be surfaced as main Overview fields, and what value type is
 * expected for each.
 */

export type FieldValueType =
  | "string"
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "enum"
  | "email"
  | "documents"
  | "datetime-list";

export type FieldScope = "consultation" | "root";

export type FieldSection = "identity" | "matter" | "logistics" | "meta" | "custom";

export type FieldService =
  | "general"
  | "immigration"
  | "corporate"
  | "real_estate"
  | "notary";

export interface FieldDef {
  id: string;
  label: string;
  order: number;
  section: FieldSection;
  valueType: FieldValueType;
  scope: FieldScope;
  options?: string[];
  placeholder?: string;
  required: boolean;
  showWhenEmpty: boolean;
  readOnly?: boolean;
  clientVisible?: boolean;
  clientEditable?: boolean;
  subLabels?: Record<string, string>;
  serviceGroup?: FieldService;
  active: boolean;
  isSeed?: boolean;
  updatedBy?: string;
  updatedAt?: string;
  createdAt?: string;
}

export const HARDCODED_FIELD_DEFS: FieldDef[] = [
  // ── Identity ────────────────────────────────────────────────────────────
  { id: "name", label: "First Name", section: "identity", valueType: "string", scope: "consultation", required: true, showWhenEmpty: true, placeholder: "—", order: 0, active: true, isSeed: true },
  { id: "surname", label: "Surname", section: "identity", valueType: "string", scope: "consultation", required: true, showWhenEmpty: true, placeholder: "—", order: 1, active: true, isSeed: true },
  { id: "email", label: "Email", section: "identity", valueType: "email", scope: "root", required: true, showWhenEmpty: false, readOnly: true, order: 2, active: true, isSeed: true },
  { id: "phone", label: "Phone", section: "identity", valueType: "string", scope: "consultation", required: false, showWhenEmpty: true, placeholder: "—", order: 3, active: true, isSeed: true },

  // ── Legal matter ─────────────────────────────────────────────────────────
  { id: "legalArea", label: "Legal Area", section: "matter", valueType: "enum", scope: "consultation", required: false, showWhenEmpty: true, placeholder: "—", options: ["immigration", "corporate", "real_estate", "notary", "other"], clientVisible: true, clientEditable: true, order: 4, active: true, isSeed: true },
  { id: "legalMatter", label: "Legal Matter", section: "matter", valueType: "enum", scope: "consultation", required: false, showWhenEmpty: true, placeholder: "—", options: ["residency_visa", "business", "property", "family_estate", "other"], clientVisible: true, clientEditable: true, order: 5, active: true, isSeed: true },
  { id: "jurisdiction", label: "Jurisdiction", section: "matter", valueType: "string", scope: "consultation", required: false, showWhenEmpty: true, placeholder: "—", clientVisible: true, clientEditable: true, order: 6, active: true, isSeed: true },
  { id: "documents", label: "Documents", section: "matter", valueType: "documents", scope: "consultation", required: false, showWhenEmpty: false, clientVisible: true, clientEditable: false, order: 7, active: true, isSeed: true },
  { id: "legalNotes", label: "Legal Notes", section: "matter", valueType: "text", scope: "consultation", required: false, showWhenEmpty: false, placeholder: "—", order: 8, active: true, isSeed: true },

  // ── Logistics / call ──────────────────────────────────────────────────────
  { id: "scheduling", label: "Scheduled Call", section: "logistics", valueType: "datetime-list", scope: "root", required: false, showWhenEmpty: true, order: 9, active: true, isSeed: true },
  { id: "callOutcome", label: "Call Outcome", section: "logistics", valueType: "text", scope: "root", required: false, showWhenEmpty: false, placeholder: "—", order: 10, active: true, isSeed: true },

  // ── Meta (read-only) ──────────────────────────────────────────────────────
  { id: "consultationCount", label: "Consultations", section: "meta", valueType: "number", scope: "root", required: false, showWhenEmpty: false, readOnly: true, order: 11, active: true, isSeed: true },
  { id: "createdAt", label: "Created", section: "meta", valueType: "date", scope: "root", required: false, showWhenEmpty: false, readOnly: true, order: 12, active: true, isSeed: true },
];

export const HARDCODED_FIELD_MAP: ReadonlyMap<string, FieldDef> = new Map(
  HARDCODED_FIELD_DEFS.map((f) => [f.id, f]),
);

const VALID_TYPES: ReadonlySet<string> = new Set<FieldValueType>([
  "string", "text", "number", "boolean", "date", "datetime", "enum",
  "email", "documents", "datetime-list",
]);

const VALID_SECTIONS: ReadonlySet<string> = new Set<FieldSection>([
  "identity", "matter", "logistics", "meta", "custom",
]);

export function normalizeFieldDef(
  row: Record<string, unknown>,
  fallbackOrder = 0,
): FieldDef {
  const id = String(row?.id ?? "").trim();
  const base = HARDCODED_FIELD_MAP.get(id);
  const num = (v: unknown, d: number): number =>
    Number.isFinite(+(v as number)) ? +(v as number) : d;
  const type = typeof row?.valueType === "string" && VALID_TYPES.has(row.valueType)
    ? (row.valueType as FieldValueType)
    : base?.valueType ?? "string";
  const section = typeof row?.section === "string" && VALID_SECTIONS.has(row.section)
    ? (row.section as FieldSection)
    : base?.section ?? "custom";
  return {
    id,
    label: typeof row?.label === "string" && row.label ? row.label : base?.label ?? id,
    order: num(row?.order, base?.order ?? fallbackOrder),
    section,
    valueType: type,
    scope: row?.scope === "root" ? "root" : row?.scope === "consultation" ? "consultation" : base?.scope ?? "consultation",
    options: Array.isArray(row?.options) ? row.options.map((o: unknown) => String(o)) : base?.options,
    placeholder: typeof row?.placeholder === "string" ? row.placeholder : base?.placeholder,
    required: typeof row?.required === "boolean" ? row.required : base?.required ?? false,
    showWhenEmpty:
      typeof row?.showWhenEmpty === "boolean" ? row.showWhenEmpty : base?.showWhenEmpty ?? true,
    readOnly: typeof row?.readOnly === "boolean" ? row.readOnly : base?.readOnly,
    clientVisible:
      typeof row?.clientVisible === "boolean" ? row.clientVisible : base?.clientVisible ?? false,
    clientEditable:
      typeof row?.clientEditable === "boolean" ? row.clientEditable : base?.clientEditable ?? false,
    subLabels:
      row?.subLabels && typeof row.subLabels === "object" && !Array.isArray(row.subLabels)
        ? Object.fromEntries(
            Object.entries(row.subLabels as Record<string, unknown>)
              .filter(([k]) => typeof k === "string" && k)
              .map(([k, v]) => [k, String(v)]),
          )
        : base?.subLabels,
    active: row?.active === false ? false : row?.active === true ? true : base?.active ?? true,
    serviceGroup:
      typeof row?.serviceGroup === "string" && row?.serviceGroup
        ? (row.serviceGroup as FieldService)
        : base?.serviceGroup,
    isSeed: row?.isSeed === true,
    updatedBy: typeof row?.updatedBy === "string" ? row.updatedBy : undefined,
    updatedAt: typeof row?.updatedAt === "string" ? row.updatedAt : undefined,
    createdAt: typeof row?.createdAt === "string" ? row.createdAt : undefined,
  };
}