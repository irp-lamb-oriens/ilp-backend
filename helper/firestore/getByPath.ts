/**
 * helper/firestore/getByPath.ts
 *
 * Safely walks a deep field path inside a plain object — supports dotted
 * notation, optional `[index]` notation, AND numeric path segments.
 *
 * Examples that are all valid:
 *
 *   getByPath(doc, "originCity")
 *   getByPath(doc, "customFields.driverPreference")
 *   getByPath(doc, "consultations.0.budget")
 *   getByPath(doc, "consultations[0].vehicles[1].make")
 *
 * Returns `undefined` when any segment is missing or the path is invalid.
 *
 * SECURITY: explicitly rejects `__proto__`, `constructor`, `prototype` segments
 * to harden against prototype-pollution if the path string ever came from
 * untrusted user input.
 */
const FORBIDDEN_SEGMENTS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

type JsonObject = Record<string, unknown>;

export function parseFieldPath(path: string): string[] {
  // Convert "a[0].b.c[1]" → "a.0.b.c.1" → ["a","0","b","c","1"]
  const flat = path.replace(/\[(\d+)\]/g, ".$1");
  return flat.split(".").filter(Boolean);
}

export default function getByPath(
  obj: unknown,
  path: string,
): unknown {
  if (obj === null || obj === undefined) return undefined;
  if (!path || typeof path !== "string") return undefined;

  const segments = parseFieldPath(path);
  let cursor: unknown = obj;

  for (const seg of segments) {
    if (FORBIDDEN_SEGMENTS.has(seg)) return undefined;
    if (cursor === null || cursor === undefined) return undefined;

    if (Array.isArray(cursor)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0) return undefined;
      cursor = cursor[idx];
    } else if (typeof cursor === "object") {
      cursor = (cursor as JsonObject)[seg];
    } else {
      return undefined;
    }
  }

  return cursor;
}

/**
 * Sets a deep value via the same path syntax. Returns the **mutated root**
 * (the same reference passed in). Creates intermediate objects/arrays as
 * needed: numeric segments produce arrays, string segments produce objects.
 *
 * Throws on forbidden / invalid segments.
 */
export function setByPath(
  obj: JsonObject,
  path: string,
  value: unknown,
): JsonObject {
  if (!path) throw new Error("setByPath: empty path");
  const segments = parseFieldPath(path);
  if (segments.length === 0) throw new Error("setByPath: empty path");

  let cursor: unknown = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const next = segments[i + 1];
    if (FORBIDDEN_SEGMENTS.has(seg)) {
      throw new Error(`setByPath: forbidden segment "${seg}"`);
    }

    const isNumericKey = /^\d+$/.test(seg);
    const nextIsNumeric = /^\d+$/.test(next);

    if (isNumericKey) {
      if (!Array.isArray(cursor)) {
        throw new Error(
          `setByPath: expected array at segment "${seg}" of "${path}"`,
        );
      }
      const idx = Number(seg);
      if (cursor[idx] === undefined || cursor[idx] === null) {
        cursor[idx] = nextIsNumeric ? [] : {};
      }
      cursor = cursor[idx];
    } else {
      const objCursor = cursor as JsonObject;
      if (objCursor[seg] === undefined || objCursor[seg] === null) {
        objCursor[seg] = nextIsNumeric ? [] : {};
      }
      cursor = objCursor[seg];
    }
  }

  const last = segments[segments.length - 1];
  if (FORBIDDEN_SEGMENTS.has(last)) {
    throw new Error(`setByPath: forbidden segment "${last}"`);
  }

  if (/^\d+$/.test(last)) {
    if (!Array.isArray(cursor)) {
      throw new Error(
        `setByPath: expected array at terminal segment "${last}" of "${path}"`,
      );
    }
    cursor[Number(last)] = value;
  } else {
    (cursor as JsonObject)[last] = value;
  }

  return obj;
}