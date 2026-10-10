/**
 * helper/firestore/coerceToType.ts
 *
 * Best-effort type-preserving coercion. The schema-agnostic field-edit
 * endpoint accepts any JSON value coming from the dashboard; the user might
 * type "5" into a text input that was rendered from a numeric Firestore field.
 * If we naively wrote the string back, we'd silently corrupt the schema.
 *
 * This helper looks at the **existing** value in the doc and coerces the
 * incoming candidate to match its type when the conversion is unambiguous.
 *
 * Rules:
 *   - existing === undefined / null  → return candidate unchanged
 *   - typeof existing === 'number'   → if candidate is numeric string → Number(candidate)
 *   - typeof existing === 'boolean'  → "true"/"false"/"1"/"0" → boolean
 *   - typeof existing === 'string'   → String(candidate)
 *   - Array existing                 → require candidate to be array; else wrap [candidate]
 *   - Object existing                → require candidate to be object; else return as-is
 *   - everything else                → return candidate as-is
 *
 * The function NEVER throws. Worst case it returns the candidate untouched.
 */
export default function coerceToType(
  existing: unknown,
  candidate: unknown,
): unknown {
  if (existing === null || existing === undefined) return candidate;

  // Number
  if (typeof existing === "number") {
    if (typeof candidate === "number") return candidate;
    if (typeof candidate === "string" && candidate.trim() !== "") {
      const n = Number(candidate);
      if (!Number.isNaN(n)) return n;
    }
    return candidate;
  }

  // Boolean
  if (typeof existing === "boolean") {
    if (typeof candidate === "boolean") return candidate;
    if (typeof candidate === "string") {
      const v = candidate.trim().toLowerCase();
      if (v === "true" || v === "1" || v === "yes") return true;
      if (v === "false" || v === "0" || v === "no" || v === "") return false;
    }
    if (typeof candidate === "number") return candidate !== 0;
    return candidate;
  }

  // String
  if (typeof existing === "string") {
    if (typeof candidate === "string") return candidate;
    if (
      candidate === null ||
      candidate === undefined ||
      typeof candidate === "object"
    ) {
      return candidate; // don't string-stringify objects on accident
    }
    return String(candidate);
  }

  // Array
  if (Array.isArray(existing)) {
    if (Array.isArray(candidate)) return candidate;
    return candidate; // pass through — caller must validate
  }

  // Object
  if (typeof existing === "object") {
    if (
      candidate !== null &&
      typeof candidate === "object" &&
      !Array.isArray(candidate)
    ) {
      return candidate;
    }
    return candidate;
  }

  return candidate;
}