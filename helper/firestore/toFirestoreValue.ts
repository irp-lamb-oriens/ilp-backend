/**
 * Convert plain JS values into Firestore REST value objects.
 * The inverse of fromFirestoreValue.
 */
export function toFirestoreValue(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) {
    return { nullValue: null };
  }

  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };

  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }

  if (value instanceof Date) {
    return { timestampValue: value.toISOString() };
  }

  if (Array.isArray(value)) {
    return {
      arrayValue: { values: value.map(toFirestoreValue) },
    };
  }

  if (typeof value === "object") {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      fields[k] = toFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }

  // Fallback — coerce to string (should be unreachable for JSON-legal types).
  return { stringValue: String(value) };
}

/** Wrap a whole plain object into a Firestore REST `fields` payload. */
export function toFirestoreDocument(
  doc: Record<string, unknown>,
): { fields: Record<string, unknown> } {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    fields[k] = toFirestoreValue(v);
  }
  return { fields };
}