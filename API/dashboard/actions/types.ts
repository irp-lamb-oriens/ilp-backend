/**
 * API/dashboard/actions/types.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Action registry types for the ILP dashboard CRM.
 */

export interface ClientAction {
  actionKey: string;
  label: string;
  description: string;
  /** Stages where this action is available. Empty = all stages. */
  stages?: string[];
  /** Whether the action requires a confirmation before executing. */
  confirm?: boolean;
  /** Real implementation. Absent = declarative/placeholder only. */
  handler?: ActionFunction;
}

export interface ClientActionsPayload {
  actions: ClientAction[];
  stage: string;
}

/** Injected into every action handler. */
export interface ActionContext {
  clientId: string;
  clientDoc: Record<string, unknown>;
  stage: string;
  actor: string;
  args: Record<string, unknown>;
}

export interface ActionResult {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
}

export type ActionFunction = (ctx: ActionContext) => Promise<ActionResult>;
