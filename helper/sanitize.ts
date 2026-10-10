/**
 * Field normalisation + sentinel-string scrubbing. Ported from IRP-funnel's
 * proven booking intake (helper/bookConsultation.ts): the classic `x || ""` /
 * `x ?? ""` guards do NOT catch the literal strings "undefined"/"null", which
 * is how "Cheryl Richardson undefined" style rows leak into the CRM and onto
 * calendar invites. Every router that accepts user-supplied freeform text
 * should call these before persisting.
 */

/** Strip the literal sentinel strings "undefined" / "null" / "none". */
export function sanitizeStr(v: unknown): string {
  const s = (v ?? "").toString().trim();
  const lowered = s.toLowerCase();
  if (lowered === "undefined" || lowered === "null" || lowered === "none") {
    return "";
  }
  return s;
}

export interface Note {
  text: string;
  author?: string;
  createdAt?: string;
}

/**
 * Coerce any `notes` shape into a canonical array of `{ text, author?,
 * createdAt? }` objects. Prevents the "agentNotes.map is not a function"
 * class of outage: a raw-string textarea must never be persisted verbatim
 * where callers expect an array.
 *
 *   - real array       -> kept, loose string entries wrapped as note objects
 *   - non-empty string -> wrapped as a single note object
 *   - "", "none", ""   -> []
 */
export function normaliseNotes(v: unknown): Note[] {
  if (Array.isArray(v)) {
    return v
      .map((n) => {
        if (n && typeof n === "object") {
          return {
            text: sanitizeStr((n as Record<string, unknown>).text),
            ...(typeof (n as Record<string, unknown>).author === "string"
              ? { author: (n as Record<string, unknown>).author as string }
              : {}),
            ...(typeof (n as Record<string, unknown>).createdAt === "string"
              ? { createdAt: (n as Record<string, unknown>).createdAt as string }
              : {}),
          } as Note;
        }
        const text = sanitizeStr(n);
        return text ? ({ text, createdAt: new Date().toISOString() } as Note) : null;
      })
      .filter((n): n is Note => n !== null && Boolean(n.text));
  }
  if (typeof v === "string") {
    const text = sanitizeStr(v);
    return text ? [{ text, createdAt: new Date().toISOString() }] : [];
  }
  return [];
}

/**
 * Firestore-safe document id from an email. Replaces both "@" and "." with
 * "_", matching the IRP-funnel `emailToDocId` convention
 * (`john.doe@gmail.com` -> `john_doe_gmail_com`).
 */
export function emailToDocId(email: string): string {
  return email.replace(/[@.]/g, "_");
}