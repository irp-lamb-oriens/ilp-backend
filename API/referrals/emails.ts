/**
 * API/referrals/emails.ts — partner emails (English or Spanish, per partner).
 * Partners are not members, so no member legal footer; a short program footer instead.
 */
import type { PartnerStatement } from "./reports.ts";
import type { Partner } from "./types.ts";

const NAVY = "#123b5d";
const ACCENT = "#5cccf7";

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function usd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  const frac = abs % 100;
  return `${sign}US$${whole}${frac ? "." + String(frac).padStart(2, "0") : ""}`;
}

const MONTHS = {
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  es: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
};

export function monthName(lang: "en" | "es", key: string): string {
  return `${MONTHS[lang].at(Number(key.slice(5, 7)) - 1)} ${key.slice(0, 4)}`;
}

const FOOTER = {
  en: "International Legal Partner partner program. You get this email because you are a registered partner.",
  es: "Programa de socios de International Legal Partner. Recibe este correo porque es socio registrado.",
};

function layout(lang: "en" | "es", o: { subject: string; hello: string; paragraphs: string[]; cta?: { label: string; url: string }; table?: Array<[string, string]>; unsubscribeUrl?: string }) {
  const ps = o.paragraphs.map((p) => `<p style="margin:0 0 14px">${esc(p)}</p>`).join("");
  const table = o.table?.length
    ? `<table style="border-collapse:collapse;margin:8px 0 18px;width:100%">${
      o.table.map(([k, v]) => `<tr><td style="padding:6px 0;border-bottom:1px solid #e3e8ec;color:#4a5a66">${esc(k)}</td><td style="padding:6px 0;border-bottom:1px solid #e3e8ec;text-align:right;font-weight:600">${esc(v)}</td></tr>`).join("")
    }</table>`
    : "";
  const cta = o.cta
    ? `<p style="margin:20px 0"><a href="${esc(o.cta.url)}" style="background:${ACCENT};color:${NAVY};padding:11px 18px;text-decoration:none;border-radius:999px;font-weight:600;display:inline-block">${esc(o.cta.label)}</a></p>`
    : "";
  const unsub = o.unsubscribeUrl
    ? `<p style="margin:8px 0 0;font-size:13px;color:#5e6d79">${lang === "es" ? "Puede apagar el resumen mensual en su portal" : "You can turn the monthly summary off in your portal"}: <a href="${esc(o.unsubscribeUrl)}" style="color:#5e6d79">${esc(o.unsubscribeUrl)}</a></p>`
    : "";
  const html = `<!doctype html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#202a33;line-height:1.55;font-size:16px;max-width:560px;margin:0 auto;padding:16px">
    <p style="margin:0 0 14px">${esc(o.hello)}</p>${ps}${table}${cta}
    <p style="margin:18px 0 0">${lang === "es" ? "Equipo ILP" : "The ILP team"}</p>
    <p style="margin:24px 0 0;font-size:13px;color:#5e6d79">${esc(FOOTER[lang])}</p>${unsub}
  </body></html>`;
  const text = [
    o.hello,
    "",
    ...o.paragraphs.flatMap((p) => [p, ""]),
    ...(o.table ?? []).map(([k, v]) => `${k}: ${v}`),
    ...(o.table?.length ? [""] : []),
    ...(o.cta ? [`${o.cta.label}: ${o.cta.url}`, ""] : []),
    lang === "es" ? "Equipo ILP" : "The ILP team",
    "",
    FOOTER[lang],
  ].join("\n");
  return { subject: o.subject, html, text };
}

const first = (name: string) => name.trim().split(/\s+/)[0] || name;

export function partnerInviteEmail(p: Pick<Partner, "name" | "language">, portalUrl: string) {
  const lang = p.language;
  return lang === "es"
    ? layout(lang, {
      subject: "Su portal de socio ILP está listo",
      hello: `Hola ${first(p.name)},`,
      paragraphs: [
        "Ya es socio de International Legal Partner. Cada persona que llegue por su link y se haga cliente le genera una comisión.",
        "En su portal encuentra sus links, ve cuántas personas llegaron, cuánto ha ganado y cuánto le hemos transferido. Entre con este correo; le enviamos un código para ingresar.",
        "Para poder pagarle, complete sus datos bancarios en la sección Pagos.",
      ],
      cta: { label: "Abrir mi portal", url: portalUrl },
    })
    : layout(lang, {
      subject: "Your ILP partner portal is ready",
      hello: `Hi ${first(p.name)},`,
      paragraphs: [
        "You are now an International Legal Partner partner. Every person who comes through your link and becomes a customer earns you a commission.",
        "Your portal has your links, how many people came, what you have earned and what we have sent you. Sign in with this email; we send you a code.",
        "So we can pay you, add your bank details under Payments.",
      ],
      cta: { label: "Open my portal", url: portalUrl },
    });
}

export function partnerCodeEmail(lang: "en" | "es", code: string) {
  return layout(lang, {
    subject: lang === "es" ? "Su código para el portal de socios ILP" : "Your ILP partner portal sign-in code",
    hello: lang === "es" ? "Hola," : "Hello,",
    paragraphs: lang === "es"
      ? [`Su código es: ${code}`, "Sirve por 10 minutos y una sola vez. Si no lo pidió, ignore este correo."]
      : [`Your code is: ${code}`, "It works for 10 minutes, once. If you did not ask for it, ignore this email."],
  });
}

/** Monthly statement about `monthKey` (YYYY-MM), built from the partner's statement. */
export function monthlyStatementEmail(st: PartnerStatement, monthKey: string, portalUrl: string, nextPayout?: string) {
  const lang = st.partner.language;
  const m = st.months.find((x) => x.month === monthKey);
  const y = st.years.find((x) => x.year === Number(monthKey.slice(0, 4)));
  const L = st.lifetime;
  const since = monthName(lang, st.partner.startedAt.slice(0, 7));
  const month = monthName(lang, monthKey);
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  if (lang === "es") {
    return layout(lang, {
      subject: `Su resumen de ${month}: ${usd(L.paidCents)} transferidos desde ${since}`,
      hello: `Hola ${first(st.partner.name)},`,
      paragraphs: [
        `Desde ${since} nos ha enviado ${n(L.leads, "persona", "personas")} y ${n(L.customers, "cliente", "clientes")}, y le hemos transferido ${usd(L.paidCents)}.`,
        L.pendingCents > 0 ? `Tiene ${usd(L.pendingCents)} por cobrar${nextPayout ? `; el próximo pago es el ${nextPayout}` : ""}.` : "No tiene saldo pendiente.",
      ],
      table: [
        [`Personas en ${month}`, String(m?.leads ?? 0)],
        [`Clientes en ${month}`, String(m?.customers ?? 0)],
        [`Ganado en ${month}`, usd(m?.earnedCents ?? 0)],
        [`Transferido en ${monthKey.slice(0, 4)}`, usd(y?.paidCents ?? 0)],
        ["Transferido desde el inicio", usd(L.paidCents)],
      ],
      cta: { label: "Ver mi portal", url: portalUrl },
      unsubscribeUrl: portalUrl,
    });
  }
  return layout(lang, {
    subject: `Your ${month} summary: ${usd(L.paidCents)} sent to you since ${since}`,
    hello: `Hi ${first(st.partner.name)},`,
    paragraphs: [
      `Since ${since} you have sent us ${n(L.leads, "person", "people")} and ${n(L.customers, "customer", "customers")}, and we have sent you ${usd(L.paidCents)}.`,
      L.pendingCents > 0 ? `${usd(L.pendingCents)} is on its way${nextPayout ? `; next payment on ${nextPayout}` : ""}.` : "You have no pending balance.",
    ],
    table: [
      [`People in ${month}`, String(m?.leads ?? 0)],
      [`Customers in ${month}`, String(m?.customers ?? 0)],
      [`Earned in ${month}`, usd(m?.earnedCents ?? 0)],
      [`Sent in ${monthKey.slice(0, 4)}`, usd(y?.paidCents ?? 0)],
      ["Sent since we started", usd(L.paidCents)],
    ],
    cta: { label: "Open my portal", url: portalUrl },
    unsubscribeUrl: portalUrl,
  });
}

export function payoutSentEmail(p: Pick<Partner, "name" | "language">, totalCents: number, reference: string, portalUrl: string, lifetimePaidCents: number) {
  const lang = p.language;
  return lang === "es"
    ? layout(lang, {
      subject: `Le transferimos ${usd(totalCents)}`,
      hello: `Hola ${first(p.name)},`,
      paragraphs: [`Le enviamos ${usd(totalCents)} (referencia ${reference}).`, `Con este pago le hemos transferido ${usd(lifetimePaidCents)} en total. Gracias por recomendarnos.`],
      cta: { label: "Ver el detalle", url: portalUrl },
    })
    : layout(lang, {
      subject: `We sent you ${usd(totalCents)}`,
      hello: `Hi ${first(p.name)},`,
      paragraphs: [`We sent you ${usd(totalCents)} (reference ${reference}).`, `With this payment we have sent you ${usd(lifetimePaidCents)} in total. Thank you for recommending us.`],
      cta: { label: "See the details", url: portalUrl },
    });
}
