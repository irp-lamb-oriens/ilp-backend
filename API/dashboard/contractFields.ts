/**
 * contractFields.ts — the legal-matter facts printed on the engagement contract.
 *
 * This is a WHITELIST, not a dump of the Overview tab. A contract has to
 * describe the work being bought; it is not a CRM record and it is not a place
 * to restate personal data that serves no contractual purpose.
 *
 * Included: the legal area, the matter type, the jurisdiction, and the
 * documents in scope. Each is a term of the engagement.
 *
 * Deliberately EXCLUDED, and why:
 *   • name / surname / email      — the parties block already identifies the
 *                                   signatory; repeating it adds nothing.
 *   • phone                       — contact detail, never a contract term.
 *   • legalNotes                  — internal attorney notes, not client terms.
 *   • scheduling / callOutcome     — CRM internals with no legal meaning.
 *   • consultationCount, createdAt — CRM internals.
 *
 * Only fields that actually carry a value are emitted, so the contract never
 * prints placeholder rows.
 */

/** Every value shape a contract field can hold. */
export type ContractValueType =
  | "string"
  | "number"
  | "date"
  | "documents";

export interface ContractFieldSlot {
  /** Field key on the client doc (or a composite id like `documents`). */
  id: string;
  label: string;
  valueType: ContractValueType;
}

export interface ContractField {
  label: string;
  value: string;
  valueType: ContractValueType;
}

/**
 * Ordered contract fields. `documents` is a composite slot that reads the
 * `documents` array and renders a count + names.
 */
export const CONTRACT_FIELD_SLOTS: ContractFieldSlot[] = [
  { id: "legalArea", label: "Legal Area", valueType: "string" },
  { id: "legalMatter", label: "Legal Matter", valueType: "string" },
  { id: "jurisdiction", label: "Jurisdiction", valueType: "string" },
  { id: "documents", label: "Documents in scope", valueType: "documents" },
];

/**
 * Read a field from the client doc.
 *
 * Top-level wins; the LAST `consultations[]` entry is the fallback, matching how
 * the rest of the CRM resolves matter facts (a client who re-submitted the form
 * is described by the matter actually being contracted).
 */
export function readField(doc: any, key: string): unknown {
  if (doc == null || typeof doc !== "object") return undefined;
  const top = (doc as Record<string, unknown>)[key];
  if (top !== undefined && top !== null && top !== "") return top;
  const entries = Array.isArray(doc.consultations) ? doc.consultations : [];
  const latest = entries[entries.length - 1];
  if (latest && typeof latest === "object") {
    const nested = (latest as Record<string, unknown>)[key];
    if (nested !== undefined && nested !== null && nested !== "") return nested;
  }
  return undefined;
}

function text(doc: any, key: string): string {
  const v = readField(doc, key);
  return v === undefined || v === null ? "" : String(v).trim();
}

function formatDate(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value).trim();
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

/** Documents in scope: a count plus the document names, when present. */
function formatDocuments(doc: any): string {
  const raw = readField(doc, "documents");
  if (!Array.isArray(raw) || raw.length === 0) return "";
  const names = raw
    .map((d: any) => {
      if (d && typeof d === "object") {
        const n = String(d.name ?? d.title ?? "").trim();
        return n;
      }
      return String(d ?? "").trim();
    })
    .filter(Boolean);
  if (names.length === 0) return "";
  return `${names.length} document${names.length === 1 ? "" : "s"}: ${names.join(", ")}`;
}

/** Format one slot. Returns an empty string when the slot has no value. */
export function formatSlot(doc: any, slot: ContractFieldSlot): string {
  switch (slot.valueType) {
    case "documents":
      return formatDocuments(doc);
    case "date":
      return formatDate(readField(doc, slot.id));
    case "number": {
      const v = readField(doc, slot.id);
      if (v === undefined || v === null || v === "") return "";
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n.toLocaleString("en-US") : String(v).trim();
    }
    case "string":
    default:
      return text(doc, slot.id);
  }
}

/**
 * Every whitelisted contract field that carries a value, in registry order.
 * Empty slots are dropped rather than printed as placeholders.
 */
export function extractContractFields(doc: any): ContractField[] {
  const rows: ContractField[] = [];
  for (const slot of CONTRACT_FIELD_SLOTS) {
    const value = formatSlot(doc, slot);
    if (value) rows.push({ label: slot.label, value, valueType: slot.valueType });
  }
  return rows;
}