/**
 * Centralized logging helper.
 * Swap the console sink for a real logger (Sentry, Datadog, GCP Logging)
 * in one place without touching call sites.
 */
export default function log(message: unknown, context?: string): void {
  const ts = new Date().toISOString();
  const prefix = context ? `[${context}] ` : "";
  const body =
    typeof message === "string"
      ? message
      : (() => {
          try {
            return JSON.stringify(message);
          } catch {
            return String(message);
          }
        })();

  console.log(`${ts} ${prefix}${body}`);
}