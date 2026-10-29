/**
 * API/csm/emails.ts — emails to CSMs (COMMS-P3): the immediate alert and the
 * daily digest. Internal emails: plain English, no member contact details
 * beyond the name, a link back to the CSM portal.
 */

import type { MemberEmail } from "../../helper/emailTemplates.ts";

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const NAVY = "#123b5d";

export const CSM_EMAIL_FOOTER = "You get this because you are a Customer Success Manager at ILP. The same items are on the bell in the CSM portal.";

const frame = (inner: string) =>
  `<!doctype html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#202a33;line-height:1.55;font-size:15px;max-width:600px;margin:0 auto;padding:16px">${inner}<p style="margin:24px 0 0;font-size:13px;color:#4a5a66">${esc(CSM_EMAIL_FOOTER)}</p></body></html>`;

/** Immediate alert (privacy request, payment failed, missing specialty). */
export function csmAlertEmail(o: { title: string; body?: string; url: string }): MemberEmail {
  const html = frame(`<h2 style="color:${NAVY};margin:0 0 12px">${esc(o.title)}</h2>${o.body ? `<p style="margin:0 0 12px">${esc(o.body)}</p>` : ""}<p><a href="${esc(o.url)}">Open in the CSM portal</a></p>`);
  return { subject: `ILP: ${o.title}`, html, text: `${o.title}\n\n${o.body ? `${o.body}\n\n` : ""}Open in the CSM portal: ${o.url}\n\n${CSM_EMAIL_FOOTER}` };
}

export interface DigestLine {
  title: string;
  detail?: string;
  url: string;
}

export interface DigestSection {
  heading: string;
  lines: DigestLine[];
  /** Lines beyond the ones listed. */
  more: number;
}

export function csmDigestEmail(o: { dayLabel: string; summary: string; sections: DigestSection[]; portalUrl: string }): MemberEmail {
  const sections = o.sections.filter((s) => s.lines.length);
  const htmlSections = sections.map((s) => {
    const items = s.lines.map((l) => `<li style="margin:0 0 6px"><a href="${esc(l.url)}" style="color:${NAVY}">${esc(l.title)}</a>${l.detail ? `<br><span style="color:#4a5a66">${esc(l.detail)}</span>` : ""}</li>`).join("");
    const more = s.more > 0 ? `<p style="margin:0 0 12px;color:#4a5a66">And ${s.more} more in the portal.</p>` : "";
    return `<h3 style="color:${NAVY};margin:20px 0 8px;font-size:16px">${esc(s.heading)}</h3><ul style="margin:0 0 8px;padding-left:18px">${items}</ul>${more}`;
  }).join("");
  const html = frame(`<h2 style="color:${NAVY};margin:0 0 8px">Your day at ILP, ${esc(o.dayLabel)}</h2><p style="margin:0 0 12px">${esc(o.summary)}</p>${htmlSections}<p style="margin:20px 0 0"><a href="${esc(o.portalUrl)}">Open Today in the CSM portal</a></p>`);
  const text = [
    `Your day at ILP, ${o.dayLabel}`,
    "",
    o.summary,
    ...sections.flatMap((s) => ["", s.heading, ...s.lines.map((l) => `- ${l.title}${l.detail ? ` (${l.detail})` : ""}: ${l.url}`), ...(s.more > 0 ? [`And ${s.more} more in the portal.`] : [])]),
    "",
    `Open Today in the CSM portal: ${o.portalUrl}`,
    "",
    CSM_EMAIL_FOOTER,
  ].join("\n");
  return { subject: `ILP today: ${o.summary}`, html, text };
}
