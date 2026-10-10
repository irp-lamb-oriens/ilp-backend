/**
 * Resolves the Firestore project id from the service account key,
 * mirroring the IRP-funnel pattern. The service account JSON is supplied
 * either inline (SERVICE_ACCOUNT_KEY env) or as a file path.
 */
export function getProjectId(): string {
  const raw = Deno.env.get("SERVICE_ACCOUNT_KEY");
  if (!raw) {
    throw new Error(
      "SERVICE_ACCOUNT_KEY environment variable is not set. The application cannot start.",
    );
  }

  // Deno's Deno.env does not expand "~" — resolve it explicitly.
  const expanded = raw.startsWith("~")
    ? raw.replace(/^~/, Deno.env.get("HOME") ?? "/root")
    : raw;

  let parsed: unknown;
  try {
    // If the value is a JSON object string, parse it. Otherwise treat as path.
    if (expanded.trim().startsWith("{")) {
      parsed = JSON.parse(expanded);
    } else {
      parsed = JSON.parse(Deno.readTextFileSync(expanded));
    }
  } catch (err) {
    throw new Error(
      `SERVICE_ACCOUNT_KEY could not be parsed: ${err instanceof Error ? err.message : err}`,
    );
  }

  const projectId = (parsed as { project_id?: string }).project_id;
  if (!projectId) {
    throw new Error("Service account key is missing `project_id`.");
  }
  return projectId;
}