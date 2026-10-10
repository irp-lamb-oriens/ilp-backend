import post from "../db/post.ts";
import type { SessionUser } from "./auth/types.ts";

/**
 * Append an immutable audit-log entry. The plan requires an audit log for
 * admin rule management and consent changes. Firestore appends are the
 * source of truth; entries are never updated or deleted.
 */
export interface AuditEntry {
  actor: { uid: string; email: string; role: string };
  action: string; // e.g. "rule.created", "consent.granted", "alert.responded"
  target: string; // e.g. "rules/CR-tax-001"
  meta?: Record<string, unknown>;
  at: string; // ISO timestamp
}

export default async function auditLog(entry: Omit<AuditEntry, "at">): Promise<void> {
  await post("audit_log", { ...entry, at: new Date().toISOString() });
}

export function auditFrom(user: SessionUser | null | undefined) {
  return {
    uid: user?.uid ?? "system",
    email: user?.email ?? "system",
    role: user?.role ?? "system",
  };
}