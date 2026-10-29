/**
 * API/routing/specialties.ts — the editable specialty list (ROUTING).
 * ──────────────────────────────────────────────────────────────────────────
 * `specialties` is seeded from DEFAULT_SPECIALTIES the first time it is read
 * empty. Staff add, rename, deactivate and merge (Settings → Specialties);
 * ids never change. Merging A into B moves every lawyer and matter from A to
 * B and leaves A inactive with `mergedInto: B`. Every change is audited.
 */

import get from "../../db/get.ts";
import put from "../../db/put.ts";
import getAll from "../../db/getAll.ts";
import query from "../../db/query.ts";
import auditLog from "../../helper/auditLog.ts";
import {
  AREA_GROUPS,
  type AreaGroupId,
  COLLECTIONS,
  COUNTRY_CODES,
  type CountryCode,
  DEFAULT_SPECIALTIES,
  type Matter,
  type Specialty,
} from "../../schemas/contracts.ts";

type Doc = Record<string, unknown>;
export type Actor = { email: string; role: string };

const audit = (actor: Actor, action: string, target: string, meta: Doc) =>
  auditLog({ actor: { uid: actor.email, email: actor.email, role: actor.role }, action, target, meta }).catch(() => undefined);

/** Every specialty, sorted by group order then `order`. Seeds the defaults when the collection is empty. */
export async function loadSpecialties(): Promise<Specialty[]> {
  let rows = (await getAll(COLLECTIONS.specialties).catch(() => [])) as unknown as Specialty[];
  if (!rows.length) {
    const at = new Date().toISOString();
    for (const s of DEFAULT_SPECIALTIES) await put(COLLECTIONS.specialties, s.id, { ...s, createdAt: at, updatedAt: at, updatedBy: "system" } as unknown as Doc);
    rows = DEFAULT_SPECIALTIES.map((s) => ({ ...s }));
  }
  const groupIndex = (g: string) => AREA_GROUPS.findIndex((x) => x.id === g);
  return rows
    .map((s) => ({ ...s, countries: Array.isArray(s.countries) ? s.countries : [], active: s.active !== false }))
    .sort((a, b) => groupIndex(a.group) - groupIndex(b.group) || (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
}

/** Follow merges: the specialty an id now means (itself when not merged). Null when unknown or inactive. */
export function resolveSpecialty(id: string | null | undefined, list: readonly Specialty[]): Specialty | null {
  let cur = id ? list.find((s) => s.id === id) : undefined;
  for (let i = 0; cur?.mergedInto && i < 10; i++) cur = list.find((s) => s.id === cur!.mergedInto);
  return cur && cur.active ? cur : null;
}

/** Cleaned list of specialty ids: known, merged ids replaced, inactive dropped, no duplicates. */
export function cleanSpecialtyIds(ids: unknown, list: readonly Specialty[]): string[] {
  const raw = Array.isArray(ids) ? ids.map(String) : [];
  return [...new Set(raw.map((id) => resolveSpecialty(id, list)?.id).filter((x): x is string => !!x))];
}

const slug = (label: string) =>
  label.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);

const isGroup = (g: unknown): g is AreaGroupId => typeof g === "string" && AREA_GROUPS.some((x) => x.id === g);
const countriesOf = (v: unknown): CountryCode[] =>
  Array.isArray(v) ? [...new Set(v.map((c) => String(c).toUpperCase()).filter((c): c is CountryCode => (COUNTRY_CODES as readonly string[]).includes(c)))] : [];

export type SpecialtyResult = { status: number; body: Doc };

/** Add a specialty. Body: { label, group, countries?, description? }. */
export async function createSpecialty(body: Doc, actor: Actor): Promise<SpecialtyResult> {
  const label = typeof body.label === "string" ? body.label.trim().replace(/\s+/g, " ").slice(0, 80) : "";
  if (label.length < 3) return { status: 400, body: { error: "Write a name of at least 3 characters." } };
  if (!isGroup(body.group)) return { status: 400, body: { error: "Choose the area this specialty belongs to." } };
  const list = await loadSpecialties();
  if (list.some((s) => s.label.toLowerCase() === label.toLowerCase())) return { status: 409, body: { error: "A specialty with this name already exists." } };
  let id = slug(label) || `specialty_${Date.now().toString(36)}`;
  if (list.some((s) => s.id === id)) id = `${id}_${Date.now().toString(36)}`.slice(0, 48);
  const at = new Date().toISOString();
  const s: Specialty = {
    id,
    label,
    group: body.group,
    countries: countriesOf(body.countries),
    ...(typeof body.description === "string" && body.description.trim() ? { description: body.description.trim().slice(0, 300) } : {}),
    active: true,
    order: Math.max(0, ...list.filter((x) => x.group === body.group).map((x) => x.order ?? 0)) + 1,
    createdAt: at,
    updatedAt: at,
    updatedBy: actor.email,
  };
  await put(COLLECTIONS.specialties, id, s as unknown as Doc);
  await audit(actor, "specialty.created", `specialties/${id}`, { label, group: s.group, countries: s.countries });
  return { status: 201, body: { specialty: s } };
}

/** Rename, move to another group, change countries or description, deactivate or reactivate. */
export async function updateSpecialty(id: string, body: Doc, actor: Actor): Promise<SpecialtyResult> {
  const cur = (await get(COLLECTIONS.specialties, id).catch(() => null)) as Specialty | null;
  if (!cur) return { status: 404, body: { error: "Specialty not found." } };
  if (cur.mergedInto) return { status: 409, body: { error: "This specialty was merged into another one and cannot be changed." } };
  const patch: Doc = {};
  if (body.label !== undefined) {
    const label = typeof body.label === "string" ? body.label.trim().replace(/\s+/g, " ").slice(0, 80) : "";
    if (label.length < 3) return { status: 400, body: { error: "Write a name of at least 3 characters." } };
    const list = await loadSpecialties();
    if (list.some((s) => s.id !== id && s.label.toLowerCase() === label.toLowerCase())) return { status: 409, body: { error: "A specialty with this name already exists." } };
    patch.label = label;
  }
  if (body.group !== undefined) {
    if (!isGroup(body.group)) return { status: 400, body: { error: "Choose the area this specialty belongs to." } };
    patch.group = body.group;
  }
  if (body.countries !== undefined) patch.countries = countriesOf(body.countries);
  if (body.description !== undefined) patch.description = typeof body.description === "string" ? body.description.trim().slice(0, 300) : "";
  if (body.active !== undefined) patch.active = body.active === true;
  if (!Object.keys(patch).length) return { status: 400, body: { error: "Nothing to change." } };
  patch.updatedAt = new Date().toISOString();
  patch.updatedBy = actor.email;
  await put(COLLECTIONS.specialties, id, patch);
  const action = patch.active === false ? "specialty.deactivated" : patch.active === true && cur.active === false ? "specialty.reactivated" : "specialty.updated";
  await audit(actor, action, `specialties/${id}`, { from: { label: cur.label, group: cur.group, active: cur.active }, to: patch });
  return { status: 200, body: { specialty: { ...cur, ...patch } } };
}

/** Pure: a lawyer's specialty list after merging `from` into `into`. */
export function remapIds(ids: readonly string[], from: string, into: string): string[] {
  return [...new Set(ids.map((x) => (x === from ? into : x)))];
}

/**
 * Merge `from` into `into`: every lawyer and open matter with `from` gets
 * `into` instead (notes move too), and `from` becomes inactive with
 * mergedInto. Returns the providers and matters changed.
 */
export async function mergeSpecialty(from: string, into: string, actor: Actor): Promise<SpecialtyResult> {
  if (!from || !into || from === into) return { status: 400, body: { error: "Choose two different specialties." } };
  const [a, b] = await Promise.all([
    get(COLLECTIONS.specialties, from).catch(() => null) as Promise<Specialty | null>,
    get(COLLECTIONS.specialties, into).catch(() => null) as Promise<Specialty | null>,
  ]);
  if (!a || !b) return { status: 404, body: { error: "Specialty not found." } };
  if (a.mergedInto) return { status: 409, body: { error: `"${a.label}" was already merged.` } };
  if (b.mergedInto || b.active === false) return { status: 409, body: { error: `"${b.label}" is not active. Merge into an active specialty.` } };
  const providers = (await query("providers", [{ field: "specialties", op: "ARRAY_CONTAINS", value: from }]).catch(() => [])) as Doc[];
  const changedProviders: string[] = [];
  for (const p of providers) {
    const ids = Array.isArray(p.specialties) ? (p.specialties as string[]) : [];
    const notes = (p.specialtyNotes && typeof p.specialtyNotes === "object" ? { ...(p.specialtyNotes as Record<string, string>) } : {}) as Record<string, string>;
    if (notes[from]) {
      notes[into] = notes[into] ? `${notes[into]}; ${notes[from]}`.slice(0, 200) : notes[from];
      delete notes[from];
    }
    await put("providers", String(p.id), { specialties: remapIds(ids, from, into), specialtyNotes: notes, updatedAt: new Date().toISOString() });
    changedProviders.push(String(p.id));
  }
  const matters = (await query(COLLECTIONS.matters, [{ field: "specialtyId", op: "EQUAL", value: from }]).catch(() => [])) as unknown as Matter[];
  for (const m of matters) await put(COLLECTIONS.matters, m.id, { specialtyId: into });
  const at = new Date().toISOString();
  await put(COLLECTIONS.specialties, from, { active: false, mergedInto: into, updatedAt: at, updatedBy: actor.email });
  await audit(actor, "specialty.merged", `specialties/${from}`, { into, providers: changedProviders, matters: matters.map((m) => m.id) });
  return { status: 200, body: { ok: true, from, into, providers: changedProviders.length, matters: matters.length } };
}
