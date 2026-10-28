/**
 * API/providers/applyEmails.ts — the four emails of a partner lawyer
 * application (T2): received, approved, changes requested, declined.
 * Plain text plus simple HTML; copy follows frontend/copy-rules.md.
 */

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

interface Mail {
  subject: string;
  html: string;
  text: string;
}

const FOOTER = "International Legal Partner (ILP). You get this email because you applied to take member calls as a partner lawyer.";

function layout(subject: string, name: string, paragraphs: string[], cta?: { label: string; url: string }): Mail {
  const hello = name ? `Hola ${name},` : "Hola,";
  const ps = paragraphs.map((p) => `<p style="margin:0 0 14px">${esc(p)}</p>`).join("");
  const button = cta
    ? `<p style="margin:20px 0"><a href="${esc(cta.url)}" style="background:#5cccf7;color:#123b5d;padding:11px 18px;text-decoration:none;border-radius:999px;font-weight:600;display:inline-block">${esc(cta.label)}</a></p>`
    : "";
  const html = `<!doctype html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#202a33;line-height:1.55;font-size:16px;max-width:560px;margin:0 auto;padding:16px">
    <p style="margin:0 0 14px">${esc(hello)}</p>${ps}${button}
    <p style="margin:18px 0 0">The ILP partner team</p>
    <p style="margin:24px 0 0;font-size:13px;color:#4a5a66">${esc(FOOTER)}</p>
  </body></html>`;
  const text = [hello, "", ...paragraphs.flatMap((p) => [p, ""]), ...(cta ? [`${cta.label}: ${cta.url}`, ""] : []), "The ILP partner team", "", FOOTER].join("\n");
  return { subject, html, text };
}

export const lawyerApplyEmails = {
  received: (o: { name: string; signInUrl: string }): Mail =>
    layout(
      "We received your ILP partner lawyer application",
      o.name,
      [
        "Thank you for applying to take member calls with ILP. Your application is now under review.",
        "What happens next: we check your carné with the Colegio de Abogados y Abogadas de Costa Rica and read your answers. If something is missing, we email you. When your profile is approved, we email you again and members can book calls with you.",
        "You can sign in to the lawyer portal now with this email address. There you can check your weekly hours and see what is left to finish. You cannot take calls until the review is done.",
      ],
      { label: "Sign in to the lawyer portal", url: o.signInUrl },
    ),
  approved: (o: { name: string; signInUrl: string }): Mail =>
    layout(
      "Your ILP partner lawyer profile is approved",
      o.name,
      [
        "Your profile is approved. From today, ILP members can book 20-minute video calls with you inside the weekly hours you set.",
        "Before your first call, sign in and check your hours, your days off and your legal areas. Each call comes with a one-screen brief about the member and their question.",
        "Your ILP customer success team handles the follow-up after each call, including quotes for paid work.",
      ],
      { label: "Open the lawyer portal", url: o.signInUrl },
    ),
  changes: (o: { name: string; note: string; applyUrl: string; signInUrl: string }): Mail =>
    layout(
      "Your ILP partner lawyer application: one thing to update",
      o.name,
      [
        "We read your application and need a change before we can approve it:",
        o.note,
        "Send the application again from the form, using the same email address. We review it again as soon as it arrives.",
      ],
      { label: "Update your application", url: o.applyUrl },
    ),
  declined: (o: { name: string; reason: string }): Mail =>
    layout(
      "Your ILP partner lawyer application",
      o.name,
      [
        "Thank you for applying to ILP. We are not able to approve your application at this time.",
        `The reason: ${o.reason}`,
        "If you think we got something wrong, reply to this email and tell us. We keep your application details as described in our privacy policy.",
      ],
    ),
};
