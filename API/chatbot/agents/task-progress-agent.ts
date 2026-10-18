/**
 * task-progress-agent.ts — answers "what's the status of my task" from the
 * tasks collection (ILP tasks, adapted from IRP ticket-progress).
 */

import get from "../../../db/get.ts";
import getAll from "../../../db/getAll.ts";
import type { TaskProgressAgentResponse } from "./types.ts";

const TASKS_COLLECTION = "tasks";

function extractTaskId(message: string): string | null {
  const m = message.match(/(?:task|ticket)\s*[#:]?\s*([a-zA-Z0-9_-]+)/i);
  return m ? m[1] : null;
}

export async function runTaskProgressAgent(
  userMessage: string,
  email?: string,
): Promise<TaskProgressAgentResponse> {
  const explicitId = extractTaskId(userMessage);
  if (explicitId) {
    const doc = await get(TASKS_COLLECTION, explicitId).catch(() => null);
    if (doc) {
      return {
        found: true,
        taskId: explicitId,
        statusText:
          `Task "${explicitId}" is ${doc.status ?? "open"}${doc.assignee ? ` (assigned to ${doc.assignee})` : ""}${doc.title ? ` — ${doc.title}` : ""}.`,
      };
    }
    return { found: false, taskId: explicitId, statusText: `No task found with id "${explicitId}".` };
  }

  // List intent: find tasks for the requester's email (if provided).
  const all = await getAll(TASKS_COLLECTION).catch(() => []);
  if (all.length === 0) {
    return { found: false, taskId: null, statusText: "There are no tasks on file yet." };
  }

  const mine = email
    ? all.filter((t) => {
        const e = typeof t.email === "string" ? t.email : typeof t.assignee === "string" ? t.assignee : null;
        return e === email;
      })
    : all;

  if (mine.length === 0) {
    return { found: false, taskId: null, statusText: "No tasks found for your account." };
  }

  const lines = mine.slice(0, 5).map((t) => {
    const id = t.id ?? "";
    const status = t.status ?? "open";
    const title = typeof t.title === "string" ? t.title : "";
    return `- ${id}: ${status}${title ? ` — ${title}` : ""}`;
  });

  return {
    found: true,
    taskId: null,
    statusText: `Found ${mine.length} task(s):\n${lines.join("\n")}`,
  };
}
