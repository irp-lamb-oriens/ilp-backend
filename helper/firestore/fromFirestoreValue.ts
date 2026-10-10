/**
 * Convert a single Firestore REST value object back to plain JS.
 * Handles: stringValue, integerValue, doubleValue, booleanValue,
 * nullValue, timestampValue, arrayValue, mapValue, bytesValue.
 */
export function fromFirestoreValue(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;

  if (Array.isArray(raw)) {
    return raw.map(fromFirestoreValue);
  }

  if (typeof raw !== "object") return raw;

  const obj = raw as Record<string, unknown>;

  if ("nullValue" in obj) return null;
  if ("stringValue" in obj) return obj.stringValue;
  if ("booleanValue" in obj) return obj.booleanValue;
  // integerValue is encoded as a string in Firestore REST
  if ("integerValue" in obj) return Number(obj.integerValue);
  if ("doubleValue" in obj) return Number(obj.doubleValue);
  if ("timestampValue" in obj) return obj.timestampValue as string;
  if ("bytesValue" in obj) return obj.bytesValue as string;

  if ("arrayValue" in obj) {
    const values = (obj.arrayValue as { values?: unknown[] })?.values ?? [];
    return values.map(fromFirestoreValue);
  }

  if ("mapValue" in obj) {
    return fromFirestoreFields(
      (obj.mapValue as { fields?: Record<string, unknown> })?.fields ?? {},
    );
  }

  // Unknown shape: return fields if present, else the object itself.
  if ("fields" in obj && typeof obj.fields === "object") {
    return fromFirestoreFields(obj.fields as Record<string, unknown>);
  }

  return obj;
}

/** Convert a `fields` map (name -> value object) into a plain object. */
export function fromFirestoreFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = fromFirestoreValue(value);
  }
  return out;
}