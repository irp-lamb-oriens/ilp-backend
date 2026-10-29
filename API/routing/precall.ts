/**
 * API/routing/precall.ts — the pre-call email to the lawyer (ROUTING).
 * ──────────────────────────────────────────────────────────────────────────
 * On booking (and on a call moved to a new lawyer) and again 24 h (when booked
 * earlier) and 1 h before (jobs/callReminders.ts), the assigned lawyer gets
 * the member's brief by email: name, country, time zone, the call time in the
 * lawyer's zone and the Meet link, the question written at booking, the
 * matter, profile facts, deadlines, earlier confirmed summaries with next
 * steps, and document NAMES (opened in the portal after sign-in, never
 * attached). Minimized: no email, phone, date of birth, ID or passport numbers.
 */

import get from "../../db/get.ts";
import query from "../../db/query.ts";
import log from "../../helper/log.ts";
import { enqueueEmail } from "../../helper/emailQueue.ts";
import { isPlaceholderDoc, isPlaceholderId } from "../../helper/placeholder.ts";
import { DOCUMENTS_COLLECTION } from "../../helper/storage.ts";
import {
  AREA_GROUPS,
  type Consultation,
  COUNTRIES,
  type CountryCode,
  type Handoff,
  type LawyerEmailLanguage,
  type Matter,
  obligationDueAt,
  type Obligation,
  PLAN_STANDARD,
  SALES_TEAM_ID,
  toAreaGroup,
  toCountryCode,
} from "../../schemas/contracts.ts";
import { memberBundle, profileRecord } from "../members/service.ts";
import { lawyerBriefUrl, lawyerTimeZone, personTimeZone } from "../calls/callService.ts";
import { dateIn, FACT_LABELS, type PreCallBrief, type PreCallKind, preCallLawyerEmail, whenIn } from "./emails.ts";

type Doc = Record<string, unknown>;
const DAY = 86_400_000;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * The lawyer's email language. COMMS-P1 (owner decision 2026-10-28): every ILP
 * email is in English, so this is always "en". The stored `emailLanguage`
 * field is kept on the profile but no longer changes the language; the
 * Spanish and Portuguese word sets stay in emails.ts, unused by default.
 */
export function emailLanguageFor(_provider?: Doc | null): LawyerEmailLanguage {
  return "en";
}

const AREA_ES: Record<string, string> = { immigration: "Migración y residencia", real_estate: "Inmuebles", corporate: "Sociedades", tax: "Impuestos", vehicle: "Vehículos", family_estate: "Familia y sucesiones", labor: "Laboral", notarial: "Actos notariales", disputes: "Litigios", banking: "Banca y cumplimiento" };
const AREA_PT: Record<string, string> = { immigration: "Imigração e residência", real_estate: "Imobiliário", corporate: "Sociedades", tax: "Impostos", vehicle: "Veículos", family_estate: "Família e sucessões", labor: "Laboral", notarial: "Atos notariais", disputes: "Litígios", banking: "Banca e conformidade" };
const areaIn = (area: unknown, lang: LawyerEmailLanguage) => {
  const g = toAreaGroup(area);
  if (!g) return lang === "pt" ? "Geral" : lang === "es" ? "General" : "General";
  return lang === "es" ? AREA_ES[g] : lang === "pt" ? AREA_PT[g] : AREA_GROUPS.find((x) => x.id === g)!.label;
};

const yesNo = (v: unknown, L: Record<string, string>) => (v === true || v === "yes" || v === "true" ? L.yes : v === false || v === "no" || v === "false" ? L.no : null);

export interface PreCallInputs {
  consultation: Pick<Consultation, "id" | "clientId" | "matterId" | "providerId" | "question" | "scheduledAt">;
  client: Doc | null;
  matters: Matter[];
  obligations: Obligation[];
  consultations: Consultation[];
  handoffs: Handoff[];
  documents: Doc[];
  lang: LawyerEmailLanguage;
  now?: Date;
}

/** Pure: the brief the email shows. Exported for tests. */
export function buildPreCallBrief(i: PreCallInputs): PreCallBrief {
  const now = i.now ?? new Date();
  const L = FACT_LABELS[i.lang];
  const p = profileRecord(i.client);
  const c = i.consultation;
  const matter = i.matters.find((m) => m.id === c.matterId) ?? i.matters.find((m) => !m.closedAt) ?? null;
  const country = toCountryCode(matter?.country) ?? toCountryCode(p.legalCountry) ?? toCountryCode(p.country) ?? ("CR" as CountryCode);
  const facts: Array<[string, string]> = [];
  const add = (k: string, v: string | null | undefined) => {
    if (v) facts.push([L[k], v]);
  };
  add("nationality", str(p.nationality));
  add("language", str(p.preferredLanguage) === "either" ? "English / Español" : str(p.preferredLanguage)?.toUpperCase() ?? null);
  const residency = [str(p.residencyStatus), str(p.residencyCategory)].filter(Boolean).join(", ");
  add("residency", residency || null);
  add("expires", str(p.residencyExpiresAt) ? dateIn(str(p.residencyExpiresAt), i.lang) : null);
  const household = [str(p.maritalStatus), p.dependents != null && p.dependents !== "" ? `${p.dependents}` : null, p.childrenAtHome != null && p.childrenAtHome !== "" ? `${p.childrenAtHome}` : null]
    .filter(Boolean).join(", ");
  add("household", household || null);
  const prop = yesNo(p.ownsProperty, L);
  add("property", prop ? [prop, str(p.propertyLocation), str(p.propertyType), str(p.propertyHolding)].filter(Boolean).join(", ") : null);
  const comp = yesNo(p.hasCompany, L);
  add("company", comp ? [comp, str(p.companyType), p.companyCount != null && p.companyCount !== "" ? `${p.companyCount}` : null].filter(Boolean).join(", ") : null);
  const veh = yesNo(p.ownsVehicle, L);
  add("vehicle", veh ? [veh, str(p.marchamoStatus)].filter(Boolean).join(", ") : null);

  const horizon = now.getTime() + 90 * DAY;
  const obligations = i.obligations
    .filter((o) => (o.status === "upcoming" || o.status === "asked") && !o.dismissedAt)
    .map((o) => ({ o, due: obligationDueAt(o) }))
    .filter((x) => x.due && Date.parse(x.due) <= horizon)
    .sort((a, b) => String(a.due).localeCompare(String(b.due)))
    .slice(0, 8)
    .map((x) => ({ title: x.o.title, due: dateIn(x.due, i.lang) }));

  const previous = i.consultations
    .filter((x) => x.id !== c.id && x.providerId === c.providerId && x.summary?.status === "confirmed" && x.scheduledAt < c.scheduledAt)
    .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt))
    .slice(0, 3)
    .map((x) => {
      const h = i.handoffs.find((y) => y.consultationId === x.id);
      return {
        date: dateIn(x.scheduledAt, i.lang),
        summary: x.summary!.text.slice(0, 600),
        nextSteps: (h?.legalNextSteps ?? []).map((s) => s.what).slice(0, 5),
      };
    });

  const documents = i.documents
    .filter((d) => !d.deletedAt)
    .map((d) => `${str(d.fileName) ?? "document"}${str(d.category) ? ` (${str(d.category)})` : ""}`)
    .slice(0, 20);

  return {
    memberName: str(p.fullName) ?? ([str(p.name), str(p.surname)].filter(Boolean).join(" ") || "ILP member"),
    country: COUNTRIES[country].name,
    memberZone: personTimeZone(p),
    question: str(c.question),
    matter: matter ? { title: matter.title, area: areaIn(matter.area, i.lang) } : null,
    facts,
    obligations,
    previous,
    documents,
  };
}

/**
 * Email the lawyer the pre-call brief. `kind`: "booked" on booking, "24h" or
 * "1h" from the reminder job. Sales calls are skipped (no lawyer). Never throws.
 */
export async function sendPreCallEmail(c: Consultation, kind: PreCallKind): Promise<boolean> {
  if (c.kind === "sales" || c.providerId === SALES_TEAM_ID) return false;
  try {
    const provider = (await get("providers", c.providerId).catch(() => null)) as Doc | null;
    const to = str(provider?.email)?.toLowerCase();
    if (!to) return false;
    const lang = emailLanguageFor(provider);
    const [b, documents, tz] = await Promise.all([
      memberBundle(c.clientId),
      query(DOCUMENTS_COLLECTION, [{ field: "clientId", op: "EQUAL", value: c.clientId }]).catch(() => []) as Promise<Doc[]>,
      lawyerTimeZone(c.providerId, provider),
    ]);
    const brief = buildPreCallBrief({
      consultation: c,
      client: b.client,
      matters: b.matters,
      obligations: b.obligations,
      consultations: b.consultations,
      handoffs: b.handoffs,
      documents,
      lang,
    });
    const mail = preCallLawyerEmail({
      lang,
      kind,
      lawyerName: str(provider?.name)?.split(" ")[0] ?? str(provider?.name) ?? "",
      when: whenIn(c.scheduledAt, tz, lang),
      durationMin: c.durationMin || PLAN_STANDARD.callLengthMin,
      meetUrl: c.meetUrl ?? null,
      briefUrl: lawyerBriefUrl(c.id),
      brief,
    });
    const placeholder = isPlaceholderDoc(c) || isPlaceholderId(c.clientId) || isPlaceholderId(c.providerId) || isPlaceholderDoc(provider) || isPlaceholderDoc(b.client);
    const key = kind === "booked"
      ? `call_booked_${c.id}_${c.providerId}_${c.scheduledAt}_lawyer`
      : `call_reminder_${c.id}_${kind}_lawyer`;
    await enqueueEmail({ to, ...mail, placeholder }, key);
    return true;
  } catch (err) {
    log(`[routing] pre-call email for ${c.id} (${kind}) failed: ${err instanceof Error ? err.message : err}`, "error");
    return false;
  }
}
