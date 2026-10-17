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
}

export interface ClientActionsPayload {
  actions: ClientAction[];
  stage: string;
}