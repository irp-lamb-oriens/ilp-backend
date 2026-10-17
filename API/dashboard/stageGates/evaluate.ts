/**
 * API/dashboard/stageGates/evaluate.ts
 * ──────────────────────────────────────────────────────────────────────────
 * The evaluation engine for the Stage-Gate rule system.
 *
 * `evaluateStageGates(clientId, targetStage, clientDoc)` returns whether a move
 * INTO `targetStage` is allowed, and — when blocked — the failing rules'
 * messages plus a human-readable breakdown of the unmet conditions.
 *
 * Retargeted to ILP's flat `clients` collection (doc id === email-normalized
 * id). Facts are resolved from the client doc directly (quotes, notes,
 * documents, transcriptInsights) rather than IRP's `consultations` subcollections.
 */

import get from "../../../db/get.ts";
import log from "../../../helper/log.ts";
import { getEnabledRulesForStage } from "./store.ts";
import {
  VALUELESS_OPERATORS,
  type GateCondition,
  type GateOperator,
  type StageGateRule,
} from "./types.ts";

const CLIENTS_COLLECTION = "clients";

/** Read a dotted path from an object (with a `consultations[0]` fallback). */
function readPath(doc: any, path: string): unknown {
  const direct = path.split(".").reduce((a: any, k) => (a == null ? undefined : a[k]), doc);
  if (direct !== undefined && direct !== null && direct !== "") return direct;
  // Fallback to the first embedded consultation record for flat CRM fields.
  return path.split(".").reduce((a: any, k) => (a == null ? undefined : a[k]), doc?.consultations?.[0]);
}

/** A lazy fact resolver, memoized per evaluation run. */
function makeFactResolver(clientDoc: any) {
  const memo = new Map<string, unknown>();

  return function resolve(fact: string): unknown {
    if (memo.has(fact)) return memo.get(fact);
    let value: unknown;

    if (fact.startsWith("field:")) {
      value = readPath(clientDoc, fact.slice("field:".length).trim());
    } else {
      switch (fact) {
        case "quotes_total":
          value = Array.isArray(clientDoc?.quotes) ? clientDoc.quotes.length : 0;
          break;
        case "quotes_sent_to_client":
          value = (Array.isArray(clientDoc?.quotes) ? clientDoc.quotes : []).filter(
            (r: any) => r?.status === "sent_to_client" || r?.status === "client_accepted",
          ).length;
          break;
        case "notes_count":
          value = Array.isArray(clientDoc?.notes) ? clientDoc.notes.length : 0;
          break;
        case "documents_count":
          value = Array.isArray(clientDoc?.documents) ? clientDoc.documents.length : 0;
          break;
        case "has_transcript_insights":
          value = clientDoc?.transcriptInsights ? 1 : 0;
          break;
        default:
          value = undefined;
      }
    }
    memo.set(fact, value);
    return value;
  };
}

/** Coerce to a number for numeric comparisons (NaN when not numeric). */
function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") return Number(v);
  if (Array.isArray(v)) return v.length;
  return NaN;
}

/** Is a resolved fact "present" (non-empty)? */
function isPresent(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** Evaluate a single condition against a resolved fact value. */
function checkCondition(op: GateOperator, actual: unknown, expected: unknown): boolean {
  switch (op) {
    case "exists":
      return isPresent(actual);
    case "not_exists":
      return !isPresent(actual);
    case "is_empty":
      return !isPresent(actual);
    case "is_not_empty":
      return isPresent(actual);
    case "eq":
      return String(actual ?? "") === String(expected ?? "");
    case "neq":
      return String(actual ?? "") !== String(expected ?? "");
    case "gt":
      return toNum(actual) > toNum(expected);
    case "gte":
      return toNum(actual) >= toNum(expected);
    case "lt":
      return toNum(actual) < toNum(expected);
    case "lte":
      return toNum(actual) <= toNum(expected);
    case "contains":
      return String(actual ?? "").toLowerCase().includes(String(expected ?? "").toLowerCase());
    case "not_contains":
      return !String(actual ?? "").toLowerCase().includes(String(expected ?? "").toLowerCase());
    default:
      return true;
  }
}

/** Human-readable description of a condition (for the block message breakdown). */
export function describeCondition(c: GateCondition): string {
  const factLabel = c.fact.startsWith("field:") ? c.fact.slice("field:".length) : c.fact;
  const opLabel: Record<GateOperator, string> = {
    exists: "must exist",
    not_exists: "must not exist",
    is_empty: "must be empty",
    is_not_empty: "must not be empty",
    eq: `must equal ${c.value ?? ""}`,
    neq: `must not equal ${c.value ?? ""}`,
    gt: `must be greater than ${c.value ?? ""}`,
    gte: `must be at least ${c.value ?? ""}`,
    lt: `must be less than ${c.value ?? ""}`,
    lte: `must be at most ${c.value ?? ""}`,
    contains: `must contain "${c.value ?? ""}"`,
    not_contains: `must not contain "${c.value ?? ""}"`,
  };
  return `${factLabel} ${opLabel[c.operator] ?? c.operator}`;
}

export interface GateEvaluation {
  allowed: boolean;
  /** Blocking rules with their message + unmet-condition descriptions. */
  blockedBy: Array<{ ruleId: string; label: string; message: string; unmet: string[] }>;
}

/**
 * Evaluate every enabled gate rule guarding `targetStage`. A rule passes when
 * its conditions satisfy its logic ("all" → every condition; "any" → at least
 * one). The move is allowed only when ALL rules pass. Never throws — on any
 * internal error it fails OPEN (allows the move) so a config/DB issue can never
 * strand a client on the board.
 */
export async function evaluateStageGates(
  clientId: string,
  targetStage: string,
  clientDoc: any,
): Promise<GateEvaluation> {
  try {
    const rules: StageGateRule[] = await getEnabledRulesForStage(targetStage);
    if (!rules.length) return { allowed: true, blockedBy: [] };

    const doc = clientDoc ?? (await get(CLIENTS_COLLECTION, clientId).catch(() => null));
    const resolve = makeFactResolver(doc);

    const blockedBy: GateEvaluation["blockedBy"] = [];

    for (const rule of rules) {
      const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
      if (!conditions.length) continue; // an empty rule never blocks

      const results: Array<{ cond: GateCondition; passed: boolean }> = [];
      for (const cond of conditions) {
        const actual = resolve(cond.fact);
        const needsValue = !VALUELESS_OPERATORS.includes(cond.operator);
        const passed = checkCondition(cond.operator, actual, needsValue ? cond.value : undefined);
        results.push({ cond, passed });
      }

      const rulePassed = rule.logic === "any"
        ? results.some((r) => r.passed)
        : results.every((r) => r.passed);

      if (!rulePassed) {
        const unmet = results.filter((r) => !r.passed).map((r) => describeCondition(r.cond));
        blockedBy.push({
          ruleId: rule.id,
          label: rule.label,
          message: rule.message?.trim() ||
            `Requirements for this stage are not yet met.`,
          unmet,
        });
      }
    }

    return { allowed: blockedBy.length === 0, blockedBy };
  } catch (err: any) {
    log(`[stageGates] evaluate failed (failing open) for ${clientId} → ${targetStage}: ${err?.message}`);
    return { allowed: true, blockedBy: [] };
  }
}