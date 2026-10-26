/**
 * API/members/events.ts — record lifecycle hooks (TASK_RULES engine lands in the next commit).
 */
export type HookCtx = { actor?: string };

export function onRecordCreated(
  _slug: string,
  _record: object,
  _ctx: HookCtx = {},
): Promise<string[]> {
  return Promise.resolve([]);
}

export function onRecordUpdated(
  _slug: string,
  _before: object,
  _after: object,
  _ctx: HookCtx = {},
): Promise<string[]> {
  return Promise.resolve([]);
}
