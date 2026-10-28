/**
 * listSchemas.ts — FILTERS: one filter language for every list and table.
 * ──────────────────────────────────────────────────────────────────────────
 * This file is byte-identical in server/schemas/listSchemas.ts and
 * frontend/src/lib/listSchemas.ts (a test in each repo checks it). It has no
 * imports, so Deno and Next.js both read it as is.
 *
 * A list declares its fields once:
 *
 *   const schema = defineListSchema({ id: "staff-members", fields: [
 *     { key: "status", label: "Membership", type: "enum", options: [...], serverParam: "status", quick: true },
 *     { key: "periodEnd", label: "Renews", type: "date", sortable: "renewal" },
 *   ]});
 *
 * The browser renders filters from it (FilterBar), sends them as query
 * params, and the server validates them against the same definition
 * (helper/listing.ts) and applies them: on the Firestore query when the
 * filter maps to an index-backed `serverParam`, otherwise in the page window.
 *
 * Wire format. A schema filter is the param `f.<key>` with an operator prefix:
 *   f.stage=in:intake,review     f.valueCents=range:10000..50000
 *   f.dueAt=before:2026-11-01    f.dueAt=after:2026-10-01
 *   f.title=has:residency        f.ready=is:1           f.csm=eq:ana@ilp.cr
 * Values inside `in:` are URI-encoded, so a comma in a value is safe.
 * `__none` matches a blank value ("No CSM", "Unassigned").
 * A single-value eq/in on a field with `serverParam` goes out as the legacy
 * param instead (`stage=intake`), so the server can use its index.
 */

export type ListFieldType =
  | "text"
  | "enum"
  | "multi-enum"
  | "date"
  | "daterange"
  | "number"
  | "numberrange"
  | "boolean"
  | "person"
  | "country";

export type FilterOp = "eq" | "in" | "range" | "contains" | "before" | "after" | "boolean";

export const FILTER_OPS: readonly FilterOp[] = ["eq", "in", "range", "contains", "before", "after", "boolean"];

export interface ListOption {
  value: string;
  label: string;
  /** Rows with this value, when the server could count them cheaply. */
  count?: number;
}

export interface ListField {
  key: string;
  label: string;
  type: ListFieldType;
  /** Fixed choices. Enum-like fields without them learn their values from the data (meta or rows). */
  options?: ListOption[];
  /** Allowed operators; default per type (DEFAULT_OPERATORS). */
  operators?: FilterOp[];
  /** Index-backed legacy query key. A single-value eq/in goes out under this name. */
  serverParam?: string;
  /** Where the value lives on a row (dotted path). Default: key. */
  path?: string;
  /** The search box also matches this field. */
  searchable?: boolean;
  /** Sortable. A string names the list's sort key when it differs from `key`. */
  sortable?: boolean | string;
  /** Shown as a table column by default. Default true. */
  defaultVisible?: boolean;
  /** Offered as a quick filter beside the search box. */
  quick?: boolean;
  /** False: a column only, never a filter. Default true. */
  filterable?: boolean;
  /** How numbers read: money in cents, minutes, days, percent. */
  unit?: "cents" | "minutes" | "days" | "percent";
}

export interface ListSchema {
  id: string;
  fields: ListField[];
}

export type FilterValue =
  | { op: "eq"; value: string }
  | { op: "in"; values: string[] }
  | { op: "range"; min?: string; max?: string }
  | { op: "contains"; value: string }
  | { op: "before"; value: string }
  | { op: "after"; value: string }
  | { op: "boolean"; value: boolean };

/** field key → its filter. */
export type FilterState = Record<string, FilterValue>;

export interface ParsedFilter {
  field: ListField;
  filter: FilterValue;
}

export class ListSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ListSchemaError";
  }
}

export const NONE = "__none";
export const FILTER_PREFIX = "f.";

export const DEFAULT_OPERATORS: Record<ListFieldType, FilterOp[]> = {
  text: ["contains", "eq"],
  enum: ["in", "eq"],
  "multi-enum": ["in", "eq"],
  date: ["range", "before", "after", "eq"],
  daterange: ["range", "before", "after"],
  number: ["range", "eq"],
  numberrange: ["range"],
  boolean: ["boolean"],
  person: ["in", "eq"],
  country: ["in", "eq"],
};

const ALLOWED: Record<ListFieldType, FilterOp[]> = {
  text: ["contains", "eq", "in"],
  enum: ["in", "eq"],
  "multi-enum": ["in", "eq"],
  date: ["range", "before", "after", "eq"],
  daterange: ["range", "before", "after"],
  number: ["range", "eq"],
  numberrange: ["range", "eq"],
  boolean: ["boolean"],
  person: ["in", "eq", "contains"],
  country: ["in", "eq"],
};

export const COUNTRY_OPTIONS: ListOption[] = [
  { value: "CR", label: "Costa Rica" },
  { value: "PA", label: "Panama" },
  { value: "MX", label: "Mexico" },
  { value: "CO", label: "Colombia" },
  { value: "ES", label: "Spain" },
  { value: "PT", label: "Portugal" },
];

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;

/** Check a schema and fill in the defaults. Throws ListSchemaError on a bad definition. */
export function defineListSchema(schema: ListSchema): ListSchema {
  if (!schema.id) throw new ListSchemaError("A list schema needs an id.");
  const seen = new Set<string>();
  const fields = schema.fields.map((f) => {
    if (!KEY_RE.test(f.key)) throw new ListSchemaError(`${schema.id}: bad field key "${f.key}".`);
    if (seen.has(f.key)) throw new ListSchemaError(`${schema.id}: field "${f.key}" is declared twice.`);
    seen.add(f.key);
    if (!(f.type in DEFAULT_OPERATORS)) throw new ListSchemaError(`${schema.id}.${f.key}: unknown type "${f.type}".`);
    const operators = f.operators ?? DEFAULT_OPERATORS[f.type];
    for (const op of operators) {
      if (!ALLOWED[f.type].includes(op)) throw new ListSchemaError(`${schema.id}.${f.key}: operator "${op}" does not fit type ${f.type}.`);
    }
    const options = f.options ?? (f.type === "country" ? COUNTRY_OPTIONS : undefined);
    return { ...f, operators, ...(options ? { options } : {}) };
  });
  return { id: schema.id, fields };
}

export function schemaField(schema: ListSchema, key: string): ListField | undefined {
  return schema.fields.find((f) => f.key === key);
}

export const isFilterable = (f: ListField) => f.filterable !== false;
export const sortKeyOf = (f: ListField): string | null => (f.sortable ? (typeof f.sortable === "string" ? f.sortable : f.key) : null);

// ── Wire format ─────────────────────────────────────────────────────────────

const enc = (v: string) => encodeURIComponent(v);
const dec = (v: string) => {
  try {
    return decodeURIComponent(v);
  } catch {
    throw new ListSchemaError("A filter value is not readable.");
  }
};

/** One filter as its param value ("in:a,b"). */
export function encodeFilter(f: FilterValue): string {
  switch (f.op) {
    case "eq":
      return `eq:${f.value}`;
    case "in":
      return `in:${f.values.map(enc).join(",")}`;
    case "range":
      return `range:${f.min ?? ""}..${f.max ?? ""}`;
    case "contains":
      return `has:${f.value}`;
    case "before":
      return `before:${f.value}`;
    case "after":
      return `after:${f.value}`;
    case "boolean":
      return `is:${f.value ? "1" : "0"}`;
  }
}

const PREFIX_OP: Record<string, FilterOp> = { eq: "eq", in: "in", range: "range", has: "contains", before: "before", after: "after", is: "boolean" };

/** A param value back to a filter. Throws ListSchemaError on an unknown operator or a bad value. */
export function decodeFilter(raw: string): FilterValue {
  const i = raw.indexOf(":");
  const op = i > 0 ? PREFIX_OP[raw.slice(0, i)] : undefined;
  if (!op) throw new ListSchemaError(`Unknown filter operator in "${raw.slice(0, 40)}".`);
  const body = raw.slice(i + 1);
  switch (op) {
    case "eq":
      return { op, value: body };
    case "in": {
      const values = body.split(",").filter((x) => x !== "").map(dec);
      if (!values.length) throw new ListSchemaError("An \"in\" filter needs at least one value.");
      return { op, values: values.slice(0, 50) };
    }
    case "range": {
      const j = body.indexOf("..");
      if (j < 0) throw new ListSchemaError("A range filter is written min..max.");
      const min = body.slice(0, j);
      const max = body.slice(j + 2);
      if (!min && !max) throw new ListSchemaError("A range filter needs a start or an end.");
      return { op, ...(min ? { min } : {}), ...(max ? { max } : {}) };
    }
    case "contains":
    case "before":
    case "after":
      if (!body) throw new ListSchemaError(`A "${op}" filter needs a value.`);
      return { op, value: body };
    case "boolean":
      if (body !== "1" && body !== "0") throw new ListSchemaError("A yes/no filter is is:1 or is:0.");
      return { op, value: body === "1" };
  }
  throw new ListSchemaError("Unknown filter operator.");
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;
const isNum = (v: string | undefined) => v === undefined || (v.trim() !== "" && Number.isFinite(Number(v)));

/** The filter fits the field: allowed operator, well-formed values. */
export function checkFilter(field: ListField, f: FilterValue): void {
  const ops = field.operators ?? DEFAULT_OPERATORS[field.type];
  if (!ops.includes(f.op)) throw new ListSchemaError(`"${field.label}" cannot be filtered with "${f.op}".`);
  const dateish = field.type === "date" || field.type === "daterange";
  const numeric = field.type === "number" || field.type === "numberrange";
  if (f.op === "range") {
    if (dateish && ((f.min && !DATE_RE.test(f.min)) || (f.max && !DATE_RE.test(f.max)))) throw new ListSchemaError(`"${field.label}" needs dates as YYYY-MM-DD.`);
    if (numeric && (!isNum(f.min) || !isNum(f.max))) throw new ListSchemaError(`"${field.label}" needs numbers.`);
  }
  if ((f.op === "before" || f.op === "after") && !DATE_RE.test(f.value)) throw new ListSchemaError(`"${field.label}" needs a date as YYYY-MM-DD.`);
  if (f.op === "eq" && numeric && !isNum(f.value)) throw new ListSchemaError(`"${field.label}" needs a number.`);
}

/**
 * Validate the schema params of a request (`f.*`). Unknown fields and
 * operators are errors; other query keys are left alone.
 */
export function parseFilterParams(schema: ListSchema, query: Record<string, unknown>): ParsedFilter[] {
  const out: ParsedFilter[] = [];
  for (const [k, raw] of Object.entries(query)) {
    if (!k.startsWith(FILTER_PREFIX)) continue;
    const key = k.slice(FILTER_PREFIX.length);
    const field = schemaField(schema, key);
    if (!field || !isFilterable(field)) throw new ListSchemaError(`Unknown filter "${key}".`);
    const value = typeof raw === "string" ? raw : Array.isArray(raw) && typeof raw[0] === "string" ? raw[0] : "";
    if (!value) continue;
    const filter = decodeFilter(value.slice(0, 1000));
    checkFilter(field, filter);
    out.push({ field, filter });
  }
  return out;
}

/** True when the filter is set (an empty "in", or a range with no ends, is not). */
export function isActiveFilter(f: FilterValue | undefined): f is FilterValue {
  if (!f) return false;
  if (f.op === "in") return f.values.length > 0;
  if (f.op === "range") return !!(f.min || f.max);
  if (f.op === "boolean") return true;
  return f.value !== "";
}

/**
 * Filter state → request params. A single-value eq/in (or a true boolean) on
 * a field with `serverParam` uses that legacy, index-backed param.
 */
export function filterParams(schema: ListSchema, state: FilterState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of schema.fields) {
    const f = state[field.key];
    if (!isActiveFilter(f)) continue;
    if (field.serverParam) {
      if (f.op === "eq") {
        out[field.serverParam] = f.value;
        continue;
      }
      if (f.op === "in" && f.values.length === 1) {
        out[field.serverParam] = f.values[0];
        continue;
      }
      if (f.op === "boolean" && f.value) {
        out[field.serverParam] = "1";
        continue;
      }
    }
    out[FILTER_PREFIX + field.key] = encodeFilter(f);
  }
  return out;
}

/** Request params → filter state (lenient: bad values are dropped). For URLs and tests. */
export function readFilterParams(schema: ListSchema, params: { get(k: string): string | null }): FilterState {
  const out: FilterState = {};
  for (const field of schema.fields) {
    if (!isFilterable(field)) continue;
    const raw = params.get(FILTER_PREFIX + field.key);
    if (raw) {
      try {
        const f = decodeFilter(raw);
        checkFilter(field, f);
        out[field.key] = f;
      } catch {
        /* ignore a hand-edited or stale value */
      }
      continue;
    }
    if (field.serverParam) {
      const legacy = params.get(field.serverParam);
      if (legacy) out[field.key] = field.type === "boolean" ? { op: "boolean", value: legacy === "1" } : { op: "eq", value: legacy };
    }
  }
  return out;
}

// ── Matching ────────────────────────────────────────────────────────────────

/** The value of a field on a row (dotted path). */
export function fieldValue(row: unknown, field: Pick<ListField, "key" | "path">): unknown {
  let cur: unknown = row;
  for (const part of (field.path ?? field.key).split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export const normalizeFilterText = (v: unknown) => String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const blank = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : blank(v) ? [] : [String(v)]);
const day = (v: unknown) => String(v ?? "").slice(0, 10);

/** One filter against one row value. */
export function matchFilter(field: ListField, f: FilterValue, value: unknown): boolean {
  const numeric = field.type === "number" || field.type === "numberrange";
  const dateish = field.type === "date" || field.type === "daterange";
  switch (f.op) {
    case "boolean":
      return Boolean(value) === f.value;
    case "eq":
    case "in": {
      const want = f.op === "eq" ? [f.value] : f.values;
      if (blank(value)) return want.includes(NONE);
      if (numeric) return want.some((w) => Number(w) === Number(value));
      const have = asList(value).map(normalizeFilterText);
      return want.some((w) => have.includes(normalizeFilterText(w)));
    }
    case "contains": {
      const needle = normalizeFilterText(f.value);
      return asList(value).some((v) => normalizeFilterText(v).includes(needle));
    }
    case "range": {
      if (blank(value)) return false;
      if (numeric) {
        const n = Number(value);
        if (!Number.isFinite(n)) return false;
        return (f.min === undefined || n >= Number(f.min)) && (f.max === undefined || n <= Number(f.max));
      }
      const d = dateish ? day(value) : String(value);
      return (f.min === undefined || d >= (dateish ? day(f.min) : f.min)) && (f.max === undefined || d <= (dateish ? day(f.max) : f.max));
    }
    case "before":
      return !blank(value) && day(value) < day(f.value);
    case "after":
      return !blank(value) && day(value) >= day(f.value);
  }
  return false;
}

export type ValueReader<T> = (row: T, field: ListField) => unknown;

/** Every filter matches the row. `read` overrides how a field is read (server joins). */
export function rowMatches<T>(row: T, filters: ParsedFilter[], read: ValueReader<T> = (r, f) => fieldValue(r, f)): boolean {
  return filters.every(({ field, filter }) => matchFilter(field, filter, read(row, field)));
}

/** Filter state → parsed filters against a schema (unknown keys dropped). */
export function parsedFromState(schema: ListSchema, state: FilterState): ParsedFilter[] {
  const out: ParsedFilter[] = [];
  for (const [key, filter] of Object.entries(state)) {
    const field = schemaField(schema, key);
    if (field && isFilterable(field) && isActiveFilter(filter)) out.push({ field, filter });
  }
  return out;
}

/** Values the search box matches for a row: every searchable field. */
export function searchValues<T>(schema: ListSchema, row: T, read: ValueReader<T> = (r, f) => fieldValue(r, f)): unknown[] {
  return schema.fields.filter((f) => f.searchable).map((f) => read(row, f));
}

const FACET_TYPES: ListFieldType[] = ["enum", "multi-enum", "person", "country", "boolean"];
const FACET_MAX = 60;

/** Counts per value of the enum-like fields (cheap over rows already in memory). */
export function facetCounts<T>(schema: ListSchema, rows: readonly T[], read: ValueReader<T> = (r, f) => fieldValue(r, f)): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const field of schema.fields) {
    if (!isFilterable(field) || !FACET_TYPES.includes(field.type)) continue;
    const counts: Record<string, number> = {};
    for (const row of rows) {
      const v = read(row, field);
      if (field.type === "boolean") {
        const k = v ? "1" : "0";
        counts[k] = (counts[k] ?? 0) + 1;
        continue;
      }
      const list = asList(v);
      if (!list.length) counts[NONE] = (counts[NONE] ?? 0) + 1;
      for (const x of new Set(list)) counts[x] = (counts[x] ?? 0) + 1;
    }
    const keys = Object.keys(counts);
    if (keys.length > FACET_MAX) {
      keys.sort((a, b) => counts[b] - counts[a]).slice(FACET_MAX).forEach((k) => delete counts[k]);
    }
    out[field.key] = counts;
  }
  return out;
}

/** The schema as sent to browsers in the list meta: no paths, options with counts. */
export interface PublicListSchema {
  id: string;
  fields: Array<Omit<ListField, "path"> & { noneCount?: number }>;
}

export function publicSchema(schema: ListSchema, facets?: Record<string, Record<string, number>>): PublicListSchema {
  return {
    id: schema.id,
    fields: schema.fields.map((f) => {
      const rest: Omit<ListField, "path"> & { path?: string } = { ...f };
      delete rest.path;
      const counts = facets?.[f.key];
      if (!counts) return rest;
      const known = f.options ?? [];
      const seen = new Set(known.map((o) => o.value));
      const learned = Object.keys(counts).filter((v) => !seen.has(v) && v !== NONE && f.type !== "boolean").sort().map((v) => ({ value: v, label: v }));
      const options = [...known, ...learned].map((o) => ({ ...o, count: counts[o.value] ?? 0 }));
      return { ...rest, ...(f.type === "boolean" ? {} : { options }), ...(counts[NONE] ? { noneCount: counts[NONE] } : {}) };
    }),
  };
}

/** Merge what the server sent (options, counts) into the local schema. */
export function mergeSchemaMeta(schema: ListSchema, remote: PublicListSchema | null | undefined): ListSchema {
  if (!remote || remote.id !== schema.id) return schema;
  const byKey = new Map(remote.fields.map((f) => [f.key, f]));
  return {
    ...schema,
    fields: schema.fields.map((f) => {
      const r = byKey.get(f.key);
      return r?.options ? { ...f, options: r.options } : f;
    }),
  };
}

// ── Option sets ─────────────────────────────────────────────────────────────

const opts = (pairs: Array<[string, string]>): ListOption[] => pairs.map(([value, label]) => ({ value, label }));

export const MEMBERSHIP_STATUS_OPTIONS = opts([["active", "Active"], ["pending", "Pending payment"], ["past_due", "Past due"], ["cancelled", "Cancelled"]]);
export const OPPORTUNITY_STAGE_OPTIONS = opts([["identified", "Identified"], ["quoted", "Quoted"], ["negotiating", "Negotiating"], ["won", "Won"], ["lost", "Lost"]]);
export const TASK_TYPE_OPTIONS = opts([
  ["onboarding", "Onboarding"],
  ["follow_up", "Follow-up"],
  ["missing_document", "Missing document"],
  ["proposal", "Proposal"],
  ["renewal", "Renewal"],
  ["escalation", "Escalation"],
  ["privacy", "Privacy"],
]);
export const PRIVACY_KIND_OPTIONS = opts([["access", "Access"], ["export", "Export"], ["rectify", "Correction"], ["delete", "Deletion"], ["restrict", "Restriction"]]);
export const PRIVACY_STATUS_OPTIONS = opts([["received", "Received"], ["in_review", "In review"], ["completed", "Completed"], ["refused", "Refused"]]);
export const DOCUMENT_CATEGORY_OPTIONS = opts([
  ["identity", "Identity"],
  ["residency", "Residency"],
  ["property", "Property"],
  ["company", "Company"],
  ["vehicle", "Vehicle"],
  ["tax", "Tax"],
  ["other", "Other"],
]);
export const TIMELINE_KIND_OPTIONS = opts([
  ["consultation", "Call"],
  ["handoff", "Handoff"],
  ["task", "Task"],
  ["quote", "Quote"],
  ["note", "Note"],
  ["audit", "Audit"],
  ["membership", "Membership"],
]);
export const APPLICATION_STATUS_OPTIONS = opts([["pending_review", "Waiting for review"], ["changes_requested", "Changes requested"], ["declined", "Declined"]]);
export const CONSULTATION_STATUS_OPTIONS = opts([["booked", "Booked"], ["in_progress", "In progress"], ["completed", "Completed"], ["no_show", "No-show"], ["cancelled", "Cancelled"]]);
export const OBLIGATION_STATUS_OPTIONS = opts([["upcoming", "Upcoming"], ["asked", "Asked the lawyer"], ["handled", "Handled"], ["dismissed", "Dismissed"]]);
export const TASK_STATUS_OPTIONS = opts([["open", "Open"], ["done", "Done"], ["cancelled", "Cancelled"]]);
/** DEADLINES: the person's own deadlines on /status/deadlines. */
export const DEADLINE_AREA_OPTIONS = opts([
  ["immigration", "Residency and visas"],
  ["property", "Property"],
  ["corporate", "Your company"],
  ["tax", "Taxes"],
  ["vehicle", "Vehicle"],
  ["employment", "People who work for you"],
  ["estate", "Family and estate"],
  ["identity", "IDs and registrations"],
  ["cross_border", "Home-country filings"],
]);
export const DEADLINE_STATUS_OPTIONS = opts([["upcoming", "To do"], ["asked", "Asked the lawyer"], ["handled", "Done"]]);
export const DEADLINE_SOURCE_OPTIONS = opts([["check", "From the free check"], ["picker", "Added by you"], ["lawyer", "Added by your lawyer"], ["staff", "Added by your ILP team"]]);

// ── Server lists (every route that answers the helper/listing.ts contract) ──

export const LIST_SCHEMAS = {
  staffQueue: defineListSchema({
    id: "staff-queue",
    fields: [
      { key: "title", label: "Task", type: "text", searchable: true, sortable: true },
      { key: "type", label: "Type", type: "enum", options: TASK_TYPE_OPTIONS, serverParam: "type", quick: true },
      { key: "memberName", label: "Member", type: "text", filterable: false },
      { key: "dueAt", label: "Due", type: "date", sortable: true, quick: true },
      { key: "createdAt", label: "Created", type: "date", sortable: true, defaultVisible: false },
      { key: "overdue", label: "Overdue", type: "boolean", quick: true },
      { key: "ownerEmail", label: "Owner", type: "person" },
      { key: "membershipStatus", label: "Membership", type: "enum", options: MEMBERSHIP_STATUS_OPTIONS, filterable: false, defaultVisible: false },
      { key: "placeholder", label: "Placeholder", type: "boolean", defaultVisible: false },
    ],
  }),
  staffMembers: defineListSchema({
    id: "staff-members",
    fields: [
      { key: "name", label: "Member", type: "text", searchable: true, sortable: true },
      { key: "email", label: "Email", type: "text", searchable: true, defaultVisible: false },
      { key: "status", label: "Membership", type: "enum", options: MEMBERSHIP_STATUS_OPTIONS, serverParam: "status", quick: true },
      { key: "completeness", label: "Profile", type: "number", unit: "percent", sortable: true },
      { key: "consultationReady", label: "Consultation-ready", type: "boolean", quick: true },
      { key: "minutesUsed", label: "Minutes used", type: "number", unit: "minutes" },
      { key: "periodEnd", label: "Renews", type: "date", sortable: "renewal" },
      { key: "activatedAt", label: "Joined", type: "date", sortable: "joined", defaultVisible: false },
      { key: "csmEmail", label: "CSM", type: "person", serverParam: "csm", quick: true },
      { key: "openTasks", label: "Open tasks", type: "number" },
      { key: "country", label: "Country", type: "country", serverParam: "country" },
      { key: "placeholder", label: "Placeholder", type: "boolean", defaultVisible: false },
    ],
  }),
  staffTimeline: defineListSchema({
    id: "staff-timeline",
    fields: [
      { key: "kind", label: "Kind", type: "enum", options: TIMELINE_KIND_OPTIONS, serverParam: "kind", quick: true },
      { key: "title", label: "Event", type: "text", searchable: true },
      { key: "body", label: "Details", type: "text", searchable: true, defaultVisible: false },
      { key: "actor", label: "By", type: "person", searchable: true },
      { key: "at", label: "When", type: "date", sortable: true, quick: true },
    ],
  }),
  staffMatters: defineListSchema({
    id: "staff-matters",
    fields: [
      { key: "title", label: "Matter", type: "text", searchable: true, sortable: true },
      { key: "stage", label: "Stage", type: "enum", serverParam: "stage", quick: true },
      { key: "stageEnteredAt", label: "In stage since", type: "date", sortable: true },
      { key: "area", label: "Area", type: "enum", serverParam: "area", quick: true },
      { key: "country", label: "Country", type: "country", serverParam: "country" },
      { key: "assignedProviderId", label: "Lawyer", type: "person", serverParam: "assignedProviderId" },
      { key: "nextStepDue", label: "Next step due", type: "date", path: "nextStep.dueAt" },
      { key: "openedAt", label: "Opened", type: "date", sortable: true, defaultVisible: false },
      { key: "source", label: "Source", type: "enum", defaultVisible: false },
    ],
  }),
  staffLawyers: defineListSchema({
    id: "staff-lawyers",
    fields: [
      { key: "name", label: "Lawyer", type: "text", searchable: true, sortable: true },
      { key: "email", label: "Email", type: "text", searchable: true, defaultVisible: false },
      { key: "legalAreas", label: "Areas", type: "multi-enum", serverParam: "area", quick: true },
      { key: "openMatters", label: "Open matters", type: "number", sortable: true },
      { key: "agingMatters", label: "Aging matters", type: "number", sortable: true },
      { key: "callsNext7d", label: "Calls next 7 days", type: "number", sortable: true },
    ],
  }),
  opportunities: defineListSchema({
    id: "staff-opportunities",
    fields: [
      { key: "title", label: "Opportunity", type: "text", searchable: true, sortable: true },
      { key: "memberName", label: "Member", type: "text", searchable: true },
      { key: "stage", label: "Stage", type: "enum", options: OPPORTUNITY_STAGE_OPTIONS, serverParam: "stage", quick: true },
      { key: "valueCents", label: "Legal fees", type: "number", unit: "cents", sortable: true },
      { key: "area", label: "Area", type: "enum", serverParam: "area", quick: true },
      { key: "nextActionDue", label: "Next action due", type: "date", path: "nextAction.dueAt", sortable: "due" },
      { key: "ownerEmail", label: "Owner", type: "person", serverParam: "owner", quick: true },
      { key: "updatedAt", label: "Updated", type: "date", sortable: true },
      { key: "createdAt", label: "Created", type: "date", sortable: true, defaultVisible: false },
      { key: "sourceKind", label: "Source", type: "enum", path: "source.kind", defaultVisible: false },
    ],
  }),
  privacyRequests: defineListSchema({
    id: "staff-privacy",
    fields: [
      { key: "memberName", label: "Member", type: "text", filterable: false },
      { key: "email", label: "Email", type: "text", searchable: true, defaultVisible: false },
      { key: "kind", label: "Request", type: "enum", options: PRIVACY_KIND_OPTIONS, serverParam: "kind", quick: true },
      { key: "status", label: "Status", type: "enum", options: PRIVACY_STATUS_OPTIONS, quick: true },
      { key: "dueAt", label: "Respond by", type: "date", sortable: true },
      { key: "overdue", label: "Overdue", type: "boolean", quick: true },
      { key: "createdAt", label: "Received", type: "date", sortable: true },
    ],
  }),
  lawyerApplications: defineListSchema({
    id: "staff-applications",
    fields: [
      { key: "name", label: "Applicant", type: "text", searchable: true, sortable: true },
      { key: "email", label: "Email", type: "text", searchable: true, defaultVisible: false },
      { key: "firmName", label: "Firm", type: "text", searchable: true },
      { key: "status", label: "Status", type: "enum", options: APPLICATION_STATUS_OPTIONS, serverParam: "appStatus", quick: true },
      { key: "legalAreas", label: "Areas", type: "multi-enum", quick: true },
      { key: "jurisdictions", label: "Countries", type: "multi-enum" },
      { key: "submittedAt", label: "Submitted", type: "date", path: "application.submittedAt", sortable: true },
    ],
  }),
  crmClients: defineListSchema({
    id: "staff-crm",
    fields: [
      { key: "name", label: "Client", type: "text", searchable: true, sortable: true },
      { key: "email", label: "Email", type: "text", searchable: true, defaultVisible: false },
      { key: "stage", label: "Stage", type: "enum", serverParam: "stage", quick: true, sortable: true },
      { key: "legalArea", label: "Area", type: "enum", quick: true },
      { key: "jurisdiction", label: "Country", type: "enum", serverParam: "jurisdiction" },
      { key: "pendingCount", label: "Pending actions", type: "number" },
      { key: "lastUpdated", label: "Updated", type: "date", sortable: true },
    ],
  }),
  emailQueue: defineListSchema({
    id: "staff-email-queue",
    fields: [
      { key: "to", label: "To", type: "text", searchable: true },
      { key: "subject", label: "Subject", type: "text", searchable: true },
      { key: "emailType", label: "Type", type: "enum", serverParam: "emailType", quick: true },
      { key: "scheduledFor", label: "Sends", type: "date", sortable: true, quick: true },
      { key: "createdAt", label: "Queued", type: "date", sortable: true, defaultVisible: false },
    ],
  }),
  providers: defineListSchema({
    id: "staff-providers",
    fields: [
      { key: "name", label: "Lawyer", type: "text", searchable: true, sortable: true },
      { key: "email", label: "Email", type: "text", searchable: true },
      { key: "firmName", label: "Firm", type: "text", searchable: true, defaultVisible: false },
      { key: "legalAreas", label: "Areas", type: "multi-enum", serverParam: "area", quick: true },
      { key: "jurisdictions", label: "Countries", type: "multi-enum", serverParam: "jurisdiction", quick: true },
      { key: "active", label: "Active", type: "boolean", quick: true },
      { key: "createdAt", label: "Added", type: "date", sortable: true, defaultVisible: false },
    ],
  }),
  vendors: defineListSchema({
    id: "staff-vendors",
    fields: [
      { key: "companyName", label: "Company", type: "text", searchable: true, sortable: true },
      { key: "contactName", label: "Contact", type: "text", searchable: true },
      { key: "email", label: "Email", type: "text", searchable: true, defaultVisible: false },
      { key: "legalAreas", label: "Areas", type: "multi-enum", quick: true },
      { key: "jurisdictions", label: "Countries", type: "multi-enum", quick: true },
      { key: "active", label: "Active", type: "boolean", quick: true },
    ],
  }),
  assignmentQueue: defineListSchema({
    id: "staff-assignment",
    fields: [
      { key: "name", label: "Client", type: "text", searchable: true, sortable: true },
      { key: "email", label: "Email", type: "text", searchable: true, defaultVisible: false },
      { key: "legalArea", label: "Area", type: "enum", quick: true },
      { key: "jurisdiction", label: "Country", type: "enum", quick: true },
      { key: "stage", label: "Stage", type: "enum" },
      { key: "lastUpdated", label: "Updated", type: "date", sortable: true },
    ],
  }),
  lawyerBoard: defineListSchema({
    id: "lawyer-board",
    fields: [
      { key: "clientName", label: "Member", type: "text", filterable: false },
      { key: "title", label: "Matter", type: "text", searchable: true, sortable: true },
      { key: "area", label: "Area", type: "enum", serverParam: "area", quick: true },
      { key: "stage", label: "Stage", type: "enum", serverParam: "stage", quick: true },
      { key: "country", label: "Country", type: "country", serverParam: "country" },
      { key: "stageEnteredAt", label: "In stage since", type: "date", sortable: true },
      { key: "openedAt", label: "Opened", type: "date", sortable: true, defaultVisible: false },
      { key: "nextStepDue", label: "Next step due", type: "date", path: "nextStep.dueAt", defaultVisible: false },
    ],
  }),
  lawyerFinance: defineListSchema({
    id: "lawyer-finance",
    fields: [
      { key: "clientName", label: "Member", type: "text", searchable: true },
      { key: "matterTitle", label: "Matter", type: "text", searchable: true },
      { key: "quoteTitle", label: "Quote", type: "text", searchable: true, defaultVisible: false },
      { key: "amount", label: "Amount", type: "number", sortable: true },
      { key: "paid", label: "Paid", type: "boolean", quick: true },
      { key: "date", label: "Date", type: "date", sortable: true, quick: true },
      { key: "note", label: "Note", type: "text", searchable: true, defaultVisible: false },
    ],
  }),
  lawyerClients: defineListSchema({
    id: "lawyer-clients",
    fields: [
      { key: "name", label: "Client", type: "text", searchable: true, sortable: true },
      { key: "email", label: "Email", type: "text", searchable: true },
      { key: "stage", label: "Stage", type: "enum", serverParam: "stage", quick: true },
      { key: "legalArea", label: "Area", type: "enum", serverParam: "area", quick: true },
      { key: "jurisdiction", label: "Country", type: "enum" },
      { key: "lastUpdated", label: "Updated", type: "date", sortable: true },
    ],
  }),
  memberDocuments: defineListSchema({
    id: "member-documents",
    fields: [
      { key: "fileName", label: "File", type: "text", searchable: true, sortable: true },
      { key: "category", label: "Kind", type: "enum", options: DOCUMENT_CATEGORY_OPTIONS, serverParam: "category", quick: true },
      { key: "matterId", label: "Matter", type: "enum", serverParam: "matterId" },
      { key: "uploadedAt", label: "Added", type: "date", sortable: true, quick: true },
      { key: "size", label: "Size", type: "number", defaultVisible: false },
    ],
  }),
  memberDeadlines: defineListSchema({
    id: "member-deadlines",
    fields: [
      { key: "title", label: "Deadline", type: "text", searchable: true, sortable: true },
      { key: "shownDueAt", label: "Date", type: "date", sortable: true },
      { key: "area", label: "Area", type: "enum", options: DEADLINE_AREA_OPTIONS, quick: true },
      { key: "status", label: "Status", type: "enum", options: DEADLINE_STATUS_OPTIONS, quick: true },
      { key: "hasDate", label: "Has a date", type: "boolean" },
      { key: "source", label: "Added from", type: "enum", options: DEADLINE_SOURCE_OPTIONS },
    ],
  }),
  memberMessages: defineListSchema({
    id: "member-messages",
    fields: [
      { key: "kind", label: "From", type: "enum", serverParam: "kind", quick: true },
      { key: "body", label: "Message", type: "text", searchable: true },
      { key: "author", label: "Author", type: "person", searchable: true },
      { key: "at", label: "Sent", type: "date", sortable: true },
    ],
  }),
  recordConsultations: defineListSchema({
    id: "record-consultations",
    fields: [
      { key: "scheduledAt", label: "When", type: "date", sortable: true, quick: true },
      { key: "status", label: "Status", type: "enum", options: CONSULTATION_STATUS_OPTIONS, serverParam: "status", quick: true },
      { key: "question", label: "Question", type: "text", searchable: true },
      { key: "recording", label: "Recording consent", type: "enum", path: "consent.recording", options: opts([["pending", "Not answered"], ["granted", "Granted"], ["declined", "Declined"]]) },
      { key: "providerId", label: "Lawyer", type: "person", serverParam: "providerId" },
      { key: "minutesUsed", label: "Minutes", type: "number" },
    ],
  }),
  recordTasks: defineListSchema({
    id: "record-tasks",
    fields: [
      { key: "title", label: "Task", type: "text", searchable: true, sortable: true },
      { key: "type", label: "Type", type: "enum", options: TASK_TYPE_OPTIONS, serverParam: "type", quick: true },
      { key: "status", label: "Status", type: "enum", options: TASK_STATUS_OPTIONS, serverParam: "status", quick: true },
      { key: "ownerEmail", label: "Owner", type: "person", serverParam: "ownerEmail" },
      { key: "dueAt", label: "Due", type: "date", sortable: true },
    ],
  }),
  recordObligations: defineListSchema({
    id: "record-obligations",
    fields: [
      { key: "title", label: "Obligation", type: "text", searchable: true, sortable: true },
      { key: "status", label: "Status", type: "enum", options: OBLIGATION_STATUS_OPTIONS, serverParam: "status", quick: true },
      { key: "country", label: "Country", type: "country" },
      { key: "dueAt", label: "Due", type: "date", sortable: true, quick: true },
      { key: "confidence", label: "Date confidence", type: "enum", options: opts([["high", "High"], ["medium", "Medium"], ["low", "Low"]]), defaultVisible: false },
    ],
  }),
  recordHandoffs: defineListSchema({
    id: "record-handoffs",
    fields: [
      { key: "approvedAt", label: "Approved", type: "date", sortable: true, quick: true },
      { key: "providerId", label: "Lawyer", type: "person", serverParam: "providerId" },
      { key: "steps", label: "Next steps", type: "text", path: "legalNextSteps", searchable: true },
    ],
  }),
  recordMemberships: defineListSchema({
    id: "record-memberships",
    fields: [
      { key: "status", label: "Status", type: "enum", options: MEMBERSHIP_STATUS_OPTIONS, serverParam: "status", quick: true },
      { key: "createdAt", label: "Created", type: "date", sortable: true },
      { key: "periodEnd", label: "Period ends", type: "date", sortable: true },
    ],
  }),
  recordLeads: defineListSchema({
    id: "record-leads",
    fields: [
      { key: "name", label: "Name", type: "text", searchable: true, sortable: true },
      { key: "email", label: "Email", type: "text", searchable: true, sortable: true },
      { key: "country", label: "Country", type: "country", serverParam: "country", quick: true },
      { key: "createdAt", label: "Created", type: "date", sortable: true },
    ],
  }),
} as const;

export type ListSchemaName = keyof typeof LIST_SCHEMAS;
