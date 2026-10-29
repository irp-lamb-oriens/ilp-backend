/**
 * API/routing/emails.ts — routing emails (ROUTING). Pure templates.
 * ──────────────────────────────────────────────────────────────────────────
 * Lawyer pre-call brief (booking, 24 h and 1 h reminders) in the lawyer's
 * email language: Spanish by default, Portuguese for Portugal, English on
 * request. Member emails stay in English. Staff and sales emails in English.
 * No document is ever attached: the brief lists file names and links to the
 * portal, where the lawyer signs in. No ID or passport numbers are included.
 * Copy follows frontend/copy-rules.md (no em dashes).
 */

import { EMAIL_FOOTER, memberEmailLayout, type MemberEmail } from "../../helper/emailTemplates.ts";
import { zoneLabel } from "../calls/callLogic.ts";
import type { LawyerEmailLanguage } from "../../schemas/contracts.ts";

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export type PreCallKind = "booked" | "24h" | "1h";

/** Facts from the member's profile, already labelled in the email's language. */
export interface PreCallBrief {
  memberName: string;
  country: string; // English name of the matter's country
  memberZone: string; // e.g. "America/New_York"
  question: string | null;
  matter: { title: string; area: string } | null;
  facts: Array<[string, string]>;
  obligations: Array<{ title: string; due: string }>;
  previous: Array<{ date: string; summary: string; nextSteps: string[] }>;
  documents: string[]; // file names (category), never the files
}

export interface PreCallInput {
  lang: LawyerEmailLanguage;
  kind: PreCallKind;
  lawyerName: string;
  when: string; // in the lawyer's time zone and language (whenIn)
  durationMin: number;
  meetUrl: string | null;
  briefUrl: string;
  brief: PreCallBrief;
}

const LOCALE: Record<LawyerEmailLanguage, string> = { es: "es-ES", pt: "pt-PT", en: "en-US" };

/** "jueves, 5 de noviembre, 9:00 (hora de Costa Rica)" in the reader's zone and language. */
export function whenIn(iso: string, tz: string, lang: LawyerEmailLanguage): string {
  const text = new Date(iso).toLocaleString(LOCALE[lang], { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", timeZone: tz });
  if (lang === "en") return `${text} (${zoneLabel(tz)})`;
  const place = (tz.split("/").pop() ?? tz).replace(/_/g, " ");
  return `${text} (hora de ${place})`;
}

/** A zone's plain name in the email's language ("hora de New York"). */
export function zoneIn(tz: string, lang: LawyerEmailLanguage): string {
  if (lang === "en") return zoneLabel(tz);
  return `hora de ${(tz.split("/").pop() ?? tz).replace(/_/g, " ")}`;
}

/** Date only, in the email's language ("5 nov 2026"). */
export function dateIn(iso: string | null | undefined, lang: LawyerEmailLanguage): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString(LOCALE[lang], { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

interface Words {
  hello: (n: string) => string;
  lead: Record<PreCallKind, (member: string, when: string, min: number) => string>;
  subject: Record<PreCallKind, (member: string, when: string) => string>;
  meet: string;
  meetPending: string;
  question: string;
  noQuestion: string;
  matter: string;
  profile: string;
  zone: string;
  country: string;
  obligations: string;
  none: string;
  previous: string;
  nextSteps: string;
  documents: string;
  noDocuments: string;
  attachNote: string;
  privacyNote: string;
  button: string;
  sign: string;
}

export const WORDS: Record<LawyerEmailLanguage, Words> = {
  es: {
    hello: (n) => `Hola ${n}:`,
    lead: {
      booked: (m, w, min) => `${m} reservó una llamada de ${min} minutos con usted para el ${w}.`,
      "24h": (m, w, min) => `Mañana tiene una llamada de ${min} minutos con ${m}: ${w}.`,
      "1h": (m, w, min) => `En una hora tiene una llamada de ${min} minutos con ${m}: ${w}.`,
    },
    subject: {
      booked: (m, w) => `Nueva llamada ILP: ${m}, ${w}`,
      "24h": (m, w) => `Recordatorio: llamada con ${m} mañana (${w})`,
      "1h": (m, w) => `Recordatorio: llamada con ${m} en una hora (${w})`,
    },
    meet: "Enlace de Google Meet",
    meetPending: "El enlace de Google Meet llegará por correo. El equipo de ILP lo está preparando.",
    question: "La pregunta del miembro",
    noQuestion: "El miembro no escribió una pregunta.",
    matter: "Asunto",
    profile: "Datos del perfil",
    zone: "Zona horaria del miembro",
    country: "País del asunto",
    obligations: "Plazos próximos",
    none: "Ninguno registrado.",
    previous: "Llamadas anteriores (resúmenes confirmados)",
    nextSteps: "Próximos pasos",
    documents: "Documentos en el portal",
    noDocuments: "El miembro aún no ha subido documentos.",
    attachNote: "Los documentos no se adjuntan a este correo. Ábralos en el portal de abogados después de iniciar sesión.",
    privacyNote: "Este correo contiene datos personales del miembro. No lo reenvíe y bórrelo cuando ya no lo necesite.",
    button: "Abrir el resumen en el portal",
    sign: "Equipo de ILP",
  },
  pt: {
    hello: (n) => `Olá ${n},`,
    lead: {
      booked: (m, w, min) => `${m} marcou uma chamada de ${min} minutos consigo para ${w}.`,
      "24h": (m, w, min) => `Amanhã tem uma chamada de ${min} minutos com ${m}: ${w}.`,
      "1h": (m, w, min) => `Daqui a uma hora tem uma chamada de ${min} minutos com ${m}: ${w}.`,
    },
    subject: {
      booked: (m, w) => `Nova chamada ILP: ${m}, ${w}`,
      "24h": (m, w) => `Lembrete: chamada com ${m} amanhã (${w})`,
      "1h": (m, w) => `Lembrete: chamada com ${m} daqui a uma hora (${w})`,
    },
    meet: "Ligação do Google Meet",
    meetPending: "A ligação do Google Meet chega por email. A equipa da ILP está a prepará-la.",
    question: "A pergunta do membro",
    noQuestion: "O membro não escreveu uma pergunta.",
    matter: "Assunto",
    profile: "Dados do perfil",
    zone: "Fuso horário do membro",
    country: "País do assunto",
    obligations: "Prazos próximos",
    none: "Nenhum registado.",
    previous: "Chamadas anteriores (resumos confirmados)",
    nextSteps: "Próximos passos",
    documents: "Documentos no portal",
    noDocuments: "O membro ainda não carregou documentos.",
    attachNote: "Os documentos não vão anexados a este email. Abra-os no portal de advogados depois de iniciar sessão.",
    privacyNote: "Este email contém dados pessoais do membro. Não o reencaminhe e apague-o quando já não precisar dele.",
    button: "Abrir o resumo no portal",
    sign: "Equipa da ILP",
  },
  en: {
    hello: (n) => `Hi ${n},`,
    lead: {
      booked: (m, w, min) => `${m} booked a ${min}-minute call with you for ${w}.`,
      "24h": (m, w, min) => `Tomorrow you have a ${min}-minute call with ${m}: ${w}.`,
      "1h": (m, w, min) => `In one hour you have a ${min}-minute call with ${m}: ${w}.`,
    },
    subject: {
      booked: (m, w) => `New ILP call: ${m}, ${w}`,
      "24h": (m, w) => `Reminder: call with ${m} tomorrow (${w})`,
      "1h": (m, w) => `Reminder: call with ${m} in one hour (${w})`,
    },
    meet: "Google Meet link",
    meetPending: "The Google Meet link is coming by email. The ILP team is setting it up.",
    question: "The member's question",
    noQuestion: "The member did not write a question.",
    matter: "Matter",
    profile: "Profile facts",
    zone: "Member's time zone",
    country: "Country of the matter",
    obligations: "Upcoming deadlines",
    none: "None on file.",
    previous: "Earlier calls (confirmed summaries)",
    nextSteps: "Next steps",
    documents: "Documents in the portal",
    noDocuments: "The member has not uploaded documents yet.",
    attachNote: "Documents are not attached to this email. Open them in the lawyer portal after you sign in.",
    privacyNote: "This email holds the member's personal data. Do not forward it, and delete it when you no longer need it.",
    button: "Open the brief in the portal",
    sign: "The ILP team",
  },
};

/** Profile fact labels per language (keys used by service.ts briefFacts). */
export const FACT_LABELS: Record<LawyerEmailLanguage, Record<string, string>> = {
  es: { residency: "Situación migratoria", expires: "Vence", household: "Hogar", property: "Propiedad", company: "Empresa", vehicle: "Vehículo", nationality: "Nacionalidad", language: "Idioma para la llamada", yes: "Sí", no: "No" },
  pt: { residency: "Situação de residência", expires: "Expira", household: "Agregado familiar", property: "Imóvel", company: "Empresa", vehicle: "Veículo", nationality: "Nacionalidade", language: "Língua da chamada", yes: "Sim", no: "Não" },
  en: { residency: "Residency status", expires: "Expires", household: "Household", property: "Property", company: "Company", vehicle: "Vehicle", nationality: "Nationality", language: "Language for the call", yes: "Yes", no: "No" },
};

const H = (t: string) => `<h3 style="color:#123b5d;font-size:15px;margin:20px 0 6px">${esc(t)}</h3>`;
const P = (t: string) => `<p style="margin:0 0 10px">${esc(t).replace(/\n/g, "<br>")}</p>`;
const UL = (items: string[]) => `<ul style="margin:0 0 10px;padding-left:20px">${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;

/**
 * The pre-call email to the lawyer: when (their time zone), Meet link, the
 * member's question, matter, profile facts, deadlines, earlier confirmed
 * summaries with next steps, and the document names. Returns subject, html, text.
 */
export function preCallLawyerEmail(o: PreCallInput): MemberEmail {
  const w = WORDS[o.lang] ?? WORDS.es;
  const b = o.brief;
  const lead = w.lead[o.kind](b.memberName, o.when, o.durationMin);
  const sections: Array<{ title: string; lines: string[]; list?: boolean }> = [
    { title: w.question, lines: [b.question?.trim() || w.noQuestion] },
    ...(b.matter ? [{ title: w.matter, lines: [`${b.matter.title} (${b.matter.area})`] }] : []),
    { title: w.profile, lines: [`${w.country}: ${b.country}`, `${w.zone}: ${zoneIn(b.memberZone, o.lang)}`, ...b.facts.map(([k, v]) => `${k}: ${v}`)], list: true },
    { title: w.obligations, lines: b.obligations.length ? b.obligations.map((x) => `${x.due}: ${x.title}`) : [w.none], list: b.obligations.length > 0 },
    ...(b.previous.length
      ? [{ title: w.previous, lines: b.previous.flatMap((p) => [`${p.date}: ${p.summary}`, ...(p.nextSteps.length ? [`${w.nextSteps}: ${p.nextSteps.join("; ")}`] : [])]), list: true }]
      : []),
    { title: w.documents, lines: b.documents.length ? b.documents : [w.noDocuments], list: b.documents.length > 0 },
  ];
  const meetHtml = o.meetUrl
    ? `<p style="margin:0 0 10px">${esc(w.meet)}: <a href="${esc(o.meetUrl)}">${esc(o.meetUrl)}</a></p>`
    : P(w.meetPending);
  const html = `<!doctype html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#202a33;line-height:1.55;font-size:15px;max-width:600px;margin:0 auto;padding:16px">
    ${P(w.hello(o.lawyerName))}${P(lead)}${meetHtml}
    ${sections.map((s) => H(s.title) + (s.list ? UL(s.lines) : s.lines.map(P).join(""))).join("")}
    <p style="margin:20px 0"><a href="${esc(o.briefUrl)}" style="background:#5cccf7;color:#123b5d;padding:10px 18px;text-decoration:none;border-radius:999px;font-weight:600;display:inline-block">${esc(w.button)}</a></p>
    <p style="margin:0 0 6px;font-size:13px;color:#4a5a66">${esc(w.attachNote)}</p>
    <p style="margin:0 0 6px;font-size:13px;color:#4a5a66">${esc(w.privacyNote)}</p>
    <p style="margin:16px 0 0">${esc(w.sign)}</p>
  </body></html>`;
  const text = [
    w.hello(o.lawyerName),
    "",
    lead,
    o.meetUrl ? `${w.meet}: ${o.meetUrl}` : w.meetPending,
    "",
    ...sections.flatMap((s) => [s.title, ...s.lines.map((l) => (s.list ? `- ${l}` : l)), ""]),
    `${w.button}: ${o.briefUrl}`,
    "",
    w.attachNote,
    w.privacyNote,
    "",
    w.sign,
  ].join("\n");
  return { subject: w.subject[o.kind](b.memberName, o.when), html, text };
}

// ─── Member emails (English) ──────────────────────────────────────────────

/** No lawyer matched yet: we are arranging one; a short call with the ILP team is set (or being set). */
export function arrangingLawyerEmail(o: { firstName?: string; country: string; salesWhen: string | null; portalUrl: string }): MemberEmail {
  return memberEmailLayout({
    subject: "We are arranging your ILP lawyer",
    firstName: o.firstName,
    paragraphs: [
      `Thank you for your question. We are choosing the right lawyer licensed in ${o.country} for it, and we will email you as soon as your lawyer is confirmed. Their open times will then appear on your ILP home.`,
      o.salesWhen
        ? `In the meantime, a short call with the ILP team is set for ${o.salesWhen}. We will use it to understand what you need and tell you what happens next. It does not use your membership minutes or calls. The invitation with the video link comes in a separate email.`
        : "In the meantime, someone from the ILP team will write to you within one working day to set up a short call. It does not use your membership minutes or calls.",
    ],
    cta: { label: "Open your ILP home", url: o.portalUrl },
  });
}

/** A lawyer was found after a wait: book the call. */
export function lawyerAssignedEmail(o: { firstName?: string; lawyerName: string; country: string; bookUrl: string }): MemberEmail {
  return memberEmailLayout({
    subject: "Your ILP lawyer is confirmed",
    firstName: o.firstName,
    paragraphs: [
      `${o.lawyerName}, a lawyer licensed in ${o.country}, will take your question.`,
      "You can book your 20-minute call now. Pick a time that suits you on your ILP home.",
    ],
    cta: { label: "Book your call", url: o.bookUrl },
  });
}

// ─── Staff and sales emails (English) ─────────────────────────────────────

export function staffNotificationEmail(o: { title: string; body?: string; url: string }): MemberEmail {
  const html = `<!doctype html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#202a33;line-height:1.55;max-width:560px">
    <h2 style="color:#123b5d;margin:0 0 12px">${esc(o.title)}</h2>${o.body ? P(o.body) : ""}
    <p><a href="${esc(o.url)}">Open in the ILP dashboard</a></p>
    <p style="font-size:13px;color:#4a5a66">Every ILP staff member gets this alert. It is also on the bell in the dashboard.</p>
  </body></html>`;
  return { subject: `ILP alert: ${o.title}`, html, text: `${o.title}\n\n${o.body ?? ""}\n\nOpen in the ILP dashboard: ${o.url}` };
}

/** To the sales inbox: a sales call booked (or to schedule) for a member nobody can take yet. */
export function salesCallEmail(o: {
  booked: boolean;
  memberName: string;
  memberEmail: string | null;
  memberPhone: string | null;
  country: string;
  need: string;
  question: string | null;
  when: string | null; // Costa Rica time
  meetUrl: string | null;
  memberUrl: string;
}): MemberEmail {
  const subject = o.booked
    ? `Sales call booked: ${o.memberName} (${o.country}, ${o.need})`
    : `Set a sales call: ${o.memberName} (${o.country}, ${o.need})`;
  const lines = [
    o.booked
      ? `A short call with ${o.memberName} is booked for ${o.when}. No lawyer matches this member yet, so the call is with the sales team.`
      : `No lawyer matches ${o.memberName} yet and no sales time was free in the next two weeks. Write to the member to set a short call.`,
    `Country: ${o.country}. Needs: ${o.need}.`,
    `Email: ${o.memberEmail ?? "not on file"}. Phone: ${o.memberPhone ?? "not on file"}.`,
    ...(o.meetUrl ? [`Google Meet: ${o.meetUrl}`] : []),
    `The call does not use the member's membership minutes.`,
  ];
  const html = `<!doctype html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#202a33;line-height:1.55;max-width:560px">
    <h2 style="color:#123b5d;margin:0 0 12px">${esc(subject)}</h2>${lines.map(P).join("")}
    ${o.question ? `${H("The member's question")}${P(o.question)}` : ""}
    <p><a href="${esc(o.memberUrl)}">Open the member in the ILP dashboard</a></p>
    <p style="font-size:13px;color:#4a5a66">This email holds personal data. Do not forward it outside ILP.</p>
  </body></html>`;
  const text = [subject, "", ...lines, ...(o.question ? ["", "The member's question:", o.question] : []), "", `Member: ${o.memberUrl}`].join("\n");
  return { subject, html, text };
}

/** Footer text reused by tests to check member emails keep the legal footer. */
export const MEMBER_FOOTER = EMAIL_FOOTER;
