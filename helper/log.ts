/**
 * Centralized logging helper.
 * Swap the console sink for a real logger (Sentry, Datadog, GCP Logging)
 * in one place without touching call sites.
 *
 * P7: email addresses are masked on the way out (`ana@example.com` →
 * `a***@example.com`), so the many "… by ${email}" lines keep the domain for
 * debugging without writing members' addresses into hosting logs.
 */
const EMAIL_RE = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

export function maskEmails(text: string): string {
  return text.replace(EMAIL_RE, "$1***@$2");
}

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

  console.log(`${ts} ${prefix}${maskEmails(body)}`);
}