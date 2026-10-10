/**
 * Centralized, plain-string HTML templates for transactional email.
 * Swap in a real template engine (MJML, React Email) later without touching
 * call sites. No external API calls — pure functions.
 */

export function complianceAlertEmail(opts: {
  firstName: string;
  obligationTitle: string;
  deadlineLabel: string;
  responseUrl: string;
}): string {
  return `<!doctype html><html><body style="font-family:sans-serif;color:#18181B;line-height:1.5">
    <h2>Compliance alert</h2>
    <p>Hi ${opts.firstName},</p>
    <p><strong>${opts.obligationTitle}</strong> is coming up: <strong>${opts.deadlineLabel}</strong>.</p>
    <p><a href="${opts.responseUrl}" style="background:#18181B;color:#fff;padding:10px 16px;text-decoration:none;border-radius:6px">Respond to this alert</a></p>
  </body></html>`;
}

export function consultationConfirmationEmail(opts: {
  firstName: string;
  providerName: string;
  slotLabel: string;
  meetingUrl?: string;
}): string {
  return `<!doctype html><html><body style="font-family:sans-serif;color:#18181B;line-height:1.5">
    <h2>Consultation confirmed</h2>
    <p>Hi ${opts.firstName},</p>
    <p>Your consultation with <strong>${opts.providerName}</strong> is booked for <strong>${opts.slotLabel}</strong>.</p>
    ${opts.meetingUrl ? `<p><a href="${opts.meetingUrl}">Join the call</a></p>` : ""}
  </body></html>`;
}

export function escalationEmail(opts: {
  staffName: string;
  profileName: string;
  obligationTitle: string;
  dashboardUrl: string;
}): string {
  return `<!doctype html><html><body style="font-family:sans-serif;color:#18181B;line-height:1.5">
    <h2>Escalation: customer needs help</h2>
    <p>Hi ${opts.staffName},</p>
    <p><strong>${opts.profileName}</strong> requested help with <strong>${opts.obligationTitle}</strong>.</p>
    <p><a href="${opts.dashboardUrl}">Open the follow-up queue</a></p>
  </body></html>`;
}