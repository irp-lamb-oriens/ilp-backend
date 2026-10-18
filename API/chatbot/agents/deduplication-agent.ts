/**
 * deduplication-agent.ts — dedupes repeated client intents/fields across turns.
 * Pure + deterministic: compares the latest message against existing state.
 */

import type { DeduplicationAgentResponse } from "./types.ts";

const IDENTITY_FIELDS = ["name", "surname", "email", "phone", "jurisdiction"];

export function runDeduplicationAgent(
  latestMessage: string,
  currentState: Record<string, unknown>,
  proposedFields: Record<string, unknown>,
): DeduplicationAgentResponse {
  const changedFields: Record<string, { before: unknown; after: unknown }> = {};
  const duplicateFields: string[] = [];

  for (const [key, after] of Object.entries(proposedFields)) {
    const before = currentState[key];
    if (before === undefined || before === null || before === "") continue;
    // Value unchanged → duplicate; identity fields that merely repeat are flagged.
    const same = JSON.stringify(before) === JSON.stringify(after);
    if (same) {
      duplicateFields.push(key);
    } else {
      changedFields[key] = { before, after };
    }
  }

  // Heuristic: a message that re-states an already-known identity field with no
  // new value is a duplicate intent.
  const lower = latestMessage.toLowerCase();
  const repeatedIdentity = IDENTITY_FIELDS.some(
    (f) => currentState[f] !== undefined && currentState[f] !== "" &&
      lower.includes(String(currentState[f]).toLowerCase()),
  );

  return {
    isDuplicate: duplicateFields.length > 0 || (repeatedIdentity && Object.keys(changedFields).length === 0 && Object.keys(proposedFields).length === 0),
    duplicateFields,
    changedFields,
  };
}
