/**
 * renderLegalEmail.ts — renders the six legal-pipeline email types for the
 * ILP Emails tab (trigger-email + email-preview).
 *
 * Resolution order per email type:
 *   1. An ENABLED `email_templates` override (subject + bodyHtml) → interpolated.
 *   2. The hardcoded legal default below.
 *
 * Both the override and the default are interpolated against the client data
 * dict (`{{ any.dotted.path }}`), field-agnostic — matching templateRender.ts.
 */

import {
  getTemplateOverride,
  interpolate,
} from "./templateRender.ts";

/** Canonical legal email-type → default subject. */
export const LEGAL_EMAIL_SUBJECTS: Record<string, string> = {
  scoping_intro: "Welcome to International Legal Partner",
  legal_review_update: "Update on your legal matter",
  quote_ready: "Your legal quote is ready",
  quote_accepted_confirmation: "Quote accepted — next steps",
  filing_started: "We've started your filing",
  matter_closed: "Your matter is complete",
  filing_deadline_reminder: "Reminder: your filing deadline is approaching",
};

/** Canonical legal email-type → default body ({{}} interpolated). */
export const LEGAL_EMAIL_DEFAULT_BODY: Record<string, string> = {
  scoping_intro: `<!doctype html><html><body style="font-family:sans-serif;color:#18181B;line-height:1.6">
    <h2>Welcome, {{name}}</h2>
    <p>Thank you for contacting International Legal Partner.</p>
    <p>We're reviewing your <strong>{{legalArea}}</strong> matter ({{legalMatter}}){{#jurisdiction}} in {{jurisdiction}}{{/jurisdiction}} and will be in touch shortly.</p>
    {{#statusPageUrl}}<p><a href="{{statusPageUrl}}" style="background:#123b5d;color:#fff;padding:10px 16px;text-decoration:none;border-radius:6px">Track your matter</a></p>{{/statusPageUrl}}
  </body></html>`,
  legal_review_update: `<!doctype html><html><body style="font-family:sans-serif;color:#18181B;line-height:1.6">
    <h2>Matter update</h2>
    <p>Hi {{name}},</p>
    <p>Here is an update on your <strong>{{legalArea}}</strong> matter.</p>
    {{#statusPageUrl}}<p><a href="{{statusPageUrl}}">Track your matter</a></p>{{/statusPageUrl}}
  </body></html>`,
  quote_ready: `<!doctype html><html><body style="font-family:sans-serif;color:#18181B;line-height:1.6">
    <h2>Your legal quote is ready</h2>
    <p>Hi {{name}},</p>
    <p>We've prepared a quote for your <strong>{{legalArea}}</strong> matter.</p>
    {{#statusPageUrl}}<p><a href="{{statusPageUrl}}" style="background:#123b5d;color:#fff;padding:10px 16px;text-decoration:none;border-radius:6px">Review your quote</a></p>{{/statusPageUrl}}
  </body></html>`,
  quote_accepted_confirmation: `<!doctype html><html><body style="font-family:sans-serif;color:#18181B;line-height:1.6">
    <h2>Quote accepted</h2>
    <p>Hi {{name}},</p>
    <p>Thank you for accepting your quote. We'll begin work on your <strong>{{legalArea}}</strong> matter right away.</p>
  </body></html>`,
  filing_started: `<!doctype html><html><body style="font-family:sans-serif;color:#18181B;line-height:1.6">
    <h2>Filing started</h2>
    <p>Hi {{name}},</p>
    <p>We've started your filing{{#jurisdiction}} in {{jurisdiction}}{{/jurisdiction}}. We'll keep you posted on progress.</p>
    {{#statusPageUrl}}<p><a href="{{statusPageUrl}}">Track your matter</a></p>{{/statusPageUrl}}
  </body></html>`,
  matter_closed: `<!doctype html><html><body style="font-family:sans-serif;color:#18181B;line-height:1.6">
    <h2>Matter complete</h2>
    <p>Hi {{name}},</p>
    <p>Your <strong>{{legalArea}}</strong> matter is complete. Thank you for choosing International Legal Partner.</p>
  </body></html>`,
  filing_deadline_reminder: `<!doctype html><html><body style="font-family:sans-serif;color:#18181B;line-height:1.6">
    <h2>Filing deadline reminder</h2>
    <p>Hi {{name}},</p>
    <p>This is a reminder that the filing deadline for your <strong>{{legalArea}}</strong> matter{{#legalMatter}} ({{legalMatter}}){{/legalMatter}} is <strong>{{filingDeadline}}</strong>.</p>
    <p>Please review any outstanding documents so we can keep your filing on schedule.</p>
    {{#statusPageUrl}}<p><a href="{{statusPageUrl}}" style="background:#123b5d;color:#fff;padding:10px 16px;text-decoration:none;border-radius:6px">Track your matter</a></p>{{/statusPageUrl}}
  </body></html>`,
};

function renderConditional(template: string, data: Record<string, unknown>): string {
  // Custom mini-templating: {{#path}}…{{/path}} blocks render their inner
  // content only when `path` resolves to a truthy value.
  return template.replace(
    /\{\{#([\w.$]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_m, path: string, inner: string) => {
      const v = resolvePath(data, path);
      return v == null || v === "" ? "" : inner;
    },
  );
}

function resolvePath(data: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((acc, key) => {
      if (acc == null || typeof acc !== "object") return undefined;
      return (acc as Record<string, unknown>)[key];
    }, data);
}

/**
 * Render one legal email type to `{ subject, bodyHtml }`. Never throws — always
 * returns a usable string (falling back to a minimal default when the type is
 * unknown).
 */
export function renderLegalEmail(
  emailType: string,
  data: Record<string, unknown>,
): { subject: string; bodyHtml: string } {
  const override = getTemplateOverride(emailType);
  if (override && override.bodyHtml) {
    return {
      subject: interpolate(override.subject || LEGAL_EMAIL_SUBJECTS[emailType] || emailType, data),
      bodyHtml: renderConditional(interpolate(override.bodyHtml, data), data),
    };
  }

  const body = LEGAL_EMAIL_DEFAULT_BODY[emailType];
  const subject = LEGAL_EMAIL_SUBJECTS[emailType] ?? `Message from International Legal Partner`;

  return {
    subject: interpolate(subject, data),
    bodyHtml: body ? renderConditional(interpolate(body, data), data) : "<p></p>",
  };
}

/** The set of email types the Emails tab can preview/send. */
export function legalEmailTypes(): string[] {
  return Object.keys(LEGAL_EMAIL_SUBJECTS);
}