/**
 * providersRouter.ts — CRUD for the legal-professional Providers registry
 *
 * Providers are legal professionals (attorneys, notaries, corporate /
 * immigration / real-estate specialists) that ILP works with. Each provider
 * is classified by:
 *   legalArea     — the legal service area they cover
 *   jurisdiction  — the country/region(s) they are admitted to practice in
 *
 * Legal areas:
 *   immigration  — residency / visa / citizenship
 *   corporate    — business formation, contracts, compliance
 *   real_estate  — property, title, conveyance
 *   notary       — notarization, apostille, certified copies
 *   family_estate — wills, estates, family law
 *   litigation   — disputes, representation
 *   compliance   — regulatory, AML, data protection
 *   other        — operator-defined / ad-hoc
 *
 * Routes:
 *   GET    /api/dashboard/providers/field-schema — known custom field names
 *   GET    /api/dashboard/providers/meta         — enum values + labels
 *   GET    /api/dashboard/providers/search        — query by area / jurisdiction
 *   GET    /api/dashboard/providers/match/:clientId — score providers vs a client
 *   GET    /api/dashboard/providers               — list all providers
 *   POST   /api/dashboard/providers               — create a provider
 *   GET    /api/dashboard/providers/:id           — get one provider
 *   PATCH  /api/dashboard/providers/:id           — update a provider
 *   DELETE /api/dashboard/providers/:id           — delete a provider
 */

import type { Express, Request, Response } from "express";
import { isListRequest, type ListSpec, pageProducer, pageRows, respondList } from "../../helper/listing.ts";
import { fieldValue, LIST_SCHEMAS } from "../../schemas/listSchemas.ts";
import asyncHandler from "../../helper/asyncHandler.ts";
import log from "../../helper/log.ts";
import get from "../../db/get.ts";
import getAll from "../../db/getAll.ts";
import put from "../../db/put.ts";
import patch from "../../db/patch.ts";
import del from "../../db/delete.ts";
import validateUser from "../../helper/auth/validateUser.ts";
import type { SessionUser } from "../../helper/auth/types.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export type LegalArea =
  | "immigration"
  | "corporate"
  | "real_estate"
  | "notary"
  | "family_estate"
  | "litigation"
  | "compliance"
  | "tax"
  | "vehicle"
  | "labor"
  | "other";

export interface ProviderContact {
  name: string;
  email: string;
  phone?: string;
}

export interface Provider {
  id: string;
  name: string;
  email: string;
  phone?: string;
  website?: string;
  contactPerson?: string;
  contacts?: ProviderContact[];

  /** Which legal service areas this provider covers */
  legalAreas: LegalArea[];
  /** Countries/regions this provider is admitted to practice in (free-text tags) */
  jurisdictions?: string[];
  /** Languages the provider works in (free-text tags) */
  languages?: string[];
  /** Professional credentials (bar admission, notary license, etc.) */
  credentials?: string;
  /** Professional liability insurance status */
  insurance?: string;
  /** Service-level agreement status */
  slaStatus?: string;
  /** Internal notes (not visible to clients) */
  notes?: string;
  /** Operator quality score, 0–5 in half-star steps. Informational only. */
  score?: number | null;
  /** Free-form extra fields added by operators. */
  customFields?: Record<string, unknown>;

  /** Whether this provider is actively considered for quotes */
  active: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt?: string;
  updatedBy?: string;
}

// Human-readable display labels — mirrored in the frontend
export const LEGAL_AREA_LABELS: Record<LegalArea, string> = {
  immigration: "Immigration (residency / visa / citizenship)",
  corporate: "Corporate (formation, contracts, compliance)",
  real_estate: "Real Estate (property, title, conveyance)",
  notary: "Notary (notarization, apostille, certified copies)",
  family_estate: "Family & Estate (wills, estates, family law)",
  litigation: "Litigation (disputes, representation)",
  compliance: "Compliance (regulatory, AML, data protection)",
  tax: "Tax (corporate and personal returns)",
  vehicle: "Vehicles (transfers, marchamo, imports)",
  labor: "Labor and domestic staff",
  other: "Other / Custom",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateProviderId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const ts = Date.now().toString(36);
  let rand = "";
  for (let i = 0; i < 6; i++) rand += chars[Math.floor(Math.random() * chars.length)];
  return `prov_${ts}_${rand}`;
}

const VALID_AREAS = new Set<string>([
  "immigration", "corporate", "real_estate", "notary",
  "family_estate", "litigation", "compliance", "tax", "vehicle", "labor", "other",
]);

function validateAreas(areas: unknown): LegalArea[] {
  if (!Array.isArray(areas) || areas.length === 0) {
    throw new Error(
      "legalAreas must be a non-empty array of: " + [...VALID_AREAS].join(", "),
    );
  }
  for (const a of areas) {
    if (!VALID_AREAS.has(a)) {
      throw new Error(
        `Invalid legalArea: "${a}". Must be one of: ${[...VALID_AREAS].join(", ")}`,
      );
    }
  }
  return areas as LegalArea[];
}

/**
 * Normalize an operator score into the range [0, 5] rounded to the nearest
 * half-star. Returns `null` for empty / non-numeric input (unrated).
 */
function normalizeScore(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : parseFloat(String(raw));
  if (!Number.isFinite(n)) return null;
  const clamped = Math.max(0, Math.min(5, n));
  return Math.round(clamped * 2) / 2;
}

/**
 * Validate & normalize an incoming `contacts` array. Each contact requires a
 * non-empty name and a valid email; phone is optional.
 */
function validateContacts(raw: unknown): ProviderContact[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("contacts must be a non-empty array of { name, email }.");
  }
  const out: ProviderContact[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") throw new Error("Each contact must be an object.");
    const rec = c as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    const email = typeof rec.email === "string" ? rec.email.trim().toLowerCase() : "";
    if (!name) throw new Error("Each contact requires a name.");
    if (!email.includes("@")) throw new Error(`Contact "${name}" needs a valid email.`);
    const phoneRaw = typeof rec.phone === "string" ? rec.phone.trim() : "";
    out.push({ name, email, ...(phoneRaw ? { phone: phoneRaw } : {}) });
  }
  return out;
}

/** Synthesize a `contacts` array from legacy root fields when absent. */
function ensureContacts<T extends {
  id: string;
  contacts?: unknown;
  email?: unknown;
  contactPerson?: unknown;
  phone?: unknown;
}>(p: T): T {
  if (Array.isArray(p.contacts) && (p.contacts as unknown[]).length > 0) return p;
  const email = typeof p.email === "string" ? p.email : "";
  const name = typeof p.contactPerson === "string" ? p.contactPerson : "";
  const phone = typeof p.phone === "string" ? p.phone : "";
  if (!email && !name) return p;
  return {
    ...p,
    contacts: [{ name: name || email, email, ...(phone ? { phone } : {}) }],
  } as T;
}

// ── Field-schema side-effect ──────────────────────────────────────────────────
// Every time a provider is saved with custom fields, union the field names into
// a global `provider_field_schema/global` document so the UI can render all
// known fields on every provider form.

async function updateFieldSchema(customFields: Record<string, unknown>): Promise<void> {
  const newKeys = Object.keys(customFields);
  if (newKeys.length === 0) return;

  try {
    const existing = await get("provider_field_schema", "global");
    const knownFields: string[] = Array.isArray(existing?.knownFields)
      ? (existing.knownFields as string[])
      : [];
    const merged = Array.from(new Set([...knownFields, ...newKeys])).sort();

    if (merged.length !== knownFields.length || merged.some((k, i) => k !== knownFields[i])) {
      await patch("provider_field_schema", "global", {
        knownFields: merged,
        updatedAt: new Date().toISOString(),
      });
    }
  } catch (e: unknown) {
    log(`[providers] field-schema update failed (non-blocking): ${e}`);
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

export default function providersRouter(app: Express) {
  log("Providers router initialized.");

  // GET /api/dashboard/providers/field-schema
  app.get(
    "/api/dashboard/providers/field-schema",
    validateUser("staff"),
    asyncHandler(async (_req: Request, res: Response) => {
      const doc = await get("provider_field_schema", "global");
      res.json({ fields: doc?.knownFields ?? [] });
    }),
  );

  // GET /api/dashboard/providers/meta — no auth (enum values + labels)
  app.get("/api/dashboard/providers/meta", (_req: Request, res: Response) => {
    res.json({
      legalAreas: Object.entries(LEGAL_AREA_LABELS).map(([value, label]) => ({ value, label })),
    });
  });

  // GET /api/dashboard/providers/search?legalArea=...&jurisdiction=...
  app.get(
    "/api/dashboard/providers/search",
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const area = typeof req.query.legalArea === "string" ? req.query.legalArea.trim() : null;
      const jurisdiction = typeof req.query.jurisdiction === "string"
        ? req.query.jurisdiction.trim().toUpperCase()
        : null;

      if (area && !VALID_AREAS.has(area)) {
        return res.status(400).json({
          error: `Invalid legalArea filter: "${area}". Must be one of: ${[...VALID_AREAS].join(", ")}`,
        });
      }

      let providers = (await getAll("providers")).filter((p) => p.active !== false);

      if (area) {
        providers = providers.filter((p) =>
          Array.isArray(p.legalAreas) && (p.legalAreas as string[]).includes(area)
        );
      }
      if (jurisdiction) {
        providers = providers.filter((p) => {
          const tags = Array.isArray(p.jurisdictions)
            ? (p.jurisdictions as string[]).map((j) => j.toUpperCase())
            : [];
          return tags.length === 0 || tags.includes(jurisdiction);
        });
      }

      return res.json({ providers, count: providers.length });
    }),
  );

  // GET /api/dashboard/providers/match/:clientId
  // Scores all active providers against a client's legal-area / jurisdiction.
  app.get(
    "/api/dashboard/providers/match/:clientId",
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const { clientId } = req.params;
      const doc = await get("clients", clientId);
      if (!doc) return res.status(404).json({ error: "Client not found.", providers: [] });

      const wantedArea = typeof doc.legalArea === "string" ? doc.legalArea : null;
      const wantedJurisdiction = typeof doc.jurisdiction === "string"
        ? doc.jurisdiction.toUpperCase()
        : null;

      const allProviders = (await getAll("providers")).filter((p) => p.active !== false);

      const scored = allProviders.map((p) => {
        let score = 0;
        if (wantedArea && Array.isArray(p.legalAreas) && (p.legalAreas as string[]).includes(wantedArea)) {
          score += 2;
        }
        if (wantedJurisdiction) {
          const tags = Array.isArray(p.jurisdictions)
            ? (p.jurisdictions as string[]).map((j) => j.toUpperCase())
            : [];
          if (tags.length === 0 || tags.includes(wantedJurisdiction)) score += 1;
        }
        return { ...p, _matchScore: score };
      });
      scored.sort((a, b) => (b._matchScore as number) - (a._matchScore as number));

      return res.json({
        providers: scored,
        clientContext: {
          clientId,
          wantedArea,
          wantedJurisdiction: wantedJurisdiction || null,
        },
        total: scored.length,
      });
    }),
  );

  // GET /api/dashboard/providers
  app.get(
    "/api/dashboard/providers",
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const activeOnly = req.query.activeOnly === "true";
      let providers = await getAll("providers");
      if (activeOnly) providers = providers.filter((p) => p.active !== false);
      providers.sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
      providers = providers.map(ensureContacts);
      if (isListRequest(req)) {
        type Row = (typeof providers)[number];
        const spec: ListSpec<Row> = {
          sorts: { name: (p) => String(p.name ?? "").toLowerCase(), createdAt: (p) => String(p.createdAt ?? "") },
          defaultSort: "name",
          filters: {
            area: (p, v) => Array.isArray(p.legalAreas) && (p.legalAreas as unknown[]).map(String).includes(v),
            jurisdiction: (p, v) => Array.isArray(p.jurisdictions) && (p.jurisdictions as unknown[]).map((x) => String(x).toUpperCase()).includes(v.toUpperCase()),
            active: (p, v) => (v === "1" ? p.active !== false : v === "0" ? p.active === false : true),
          },
          search: (p) => [p.name, p.email, p.firmName, p.legalAreas, p.jurisdictions],
          schema: LIST_SCHEMAS.providers,
          read: (p, f) => (f.key === "active" ? p.active !== false : fieldValue(p, f)),
        };
        return respondList(req, res, spec, (lp) => ({ produce: pageProducer(pageRows(providers, lp, spec)) }));
      }
      return res.json({ providers, count: providers.length });
    }),
  );

  // POST /api/dashboard/providers
  app.post(
    "/api/dashboard/providers",
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const actor = (req as Request & { sessionUser?: SessionUser }).sessionUser?.uid ?? "unknown";
      const {
        name, email, phone, website, contactPerson, contacts,
        legalAreas, jurisdictions, languages, credentials, insurance, slaStatus,
        notes,
      } = req.body || {};

      if (!name || typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ error: "name is required." });
      }

      let contactList: ProviderContact[] | undefined;
      if (contacts !== undefined) {
        try {
          contactList = validateContacts(contacts);
        } catch (err) {
          return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }
      const primary = contactList?.[0];
      const resolvedEmail = primary
        ? primary.email
        : (typeof email === "string" ? email.trim().toLowerCase() : "");
      const resolvedContactPerson = primary
        ? primary.name
        : (contactPerson ? String(contactPerson).trim() : "");
      const resolvedPhone = primary?.phone ?? (phone ? String(phone).trim() : "");

      if (!resolvedEmail || !resolvedEmail.includes("@")) {
        return res.status(400).json({ error: "A valid email is required." });
      }

      let areas: LegalArea[];
      try {
        areas = validateAreas(legalAreas);
      } catch (err) {
        return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }

      const id = generateProviderId();
      const nowIso = new Date().toISOString();

      const customFields =
        typeof req.body?.customFields === "object" &&
        req.body.customFields !== null &&
        !Array.isArray(req.body.customFields)
          ? (req.body.customFields as Record<string, unknown>)
          : undefined;

      const provider: Provider = {
        id,
        name: name.trim(),
        email: resolvedEmail,
        ...(resolvedPhone ? { phone: resolvedPhone } : {}),
        ...(website ? { website: String(website).trim() } : {}),
        ...(resolvedContactPerson ? { contactPerson: resolvedContactPerson } : {}),
        ...(contactList ? { contacts: contactList } : {}),
        legalAreas: areas,
        ...(Array.isArray(jurisdictions) ? { jurisdictions } : {}),
        ...(Array.isArray(languages) ? { languages } : {}),
        ...(credentials ? { credentials: String(credentials).trim() } : {}),
        ...(insurance ? { insurance: String(insurance).trim() } : {}),
        ...(slaStatus ? { slaStatus: String(slaStatus).trim() } : {}),
        ...(notes ? { notes: String(notes).trim() } : {}),
        ...(customFields ? { customFields } : {}),
        active: true,
        createdAt: nowIso,
        createdBy: actor,
      };

      await put("providers", id, provider as unknown as Record<string, unknown>);
      if (customFields) updateFieldSchema(customFields);
      log(`[providers] ${actor} created provider ${id} (${name})`);
      return res.status(201).json({ success: true, provider });
    }),
  );

  // GET /api/dashboard/providers/:id
  app.get(
    "/api/dashboard/providers/:id",
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const doc = await get("providers", req.params.id);
      if (!doc) return res.status(404).json({ error: "Provider not found." });
      return res.json({ provider: ensureContacts({ id: req.params.id, ...doc }) });
    }),
  );

  // PATCH /api/dashboard/providers/:id
  app.patch(
    "/api/dashboard/providers/:id",
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const actor = (req as Request & { sessionUser?: SessionUser }).sessionUser?.uid ?? "unknown";

      const existing = await get("providers", id);
      if (!existing) return res.status(404).json({ error: "Provider not found." });

      const allowed = [
        "name", "email", "phone", "website", "contactPerson",
        "legalAreas", "jurisdictions", "languages", "credentials",
        "insurance", "slaStatus", "notes", "active",
      ] as const;

      const updates: Record<string, unknown> = {};
      for (const key of allowed) {
        if (req.body[key] !== undefined) updates[key] = req.body[key];
      }

      if (req.body.contacts !== undefined) {
        let contactList: ProviderContact[];
        try {
          contactList = validateContacts(req.body.contacts);
        } catch (err) {
          return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
        updates.contacts = contactList;
        updates.email = contactList[0].email;
        updates.contactPerson = contactList[0].name;
        if (contactList[0].phone) updates.phone = contactList[0].phone;
      }

      if (req.body.score !== undefined) {
        updates.score = normalizeScore(req.body.score);
      }

      if (
        typeof req.body.customFields === "object" &&
        req.body.customFields !== null &&
        !Array.isArray(req.body.customFields)
      ) {
        const incomingCF = req.body.customFields as Record<string, unknown>;
        updates.customFields = { ...(existing.customFields ?? {}), ...incomingCF };
        updateFieldSchema(incomingCF);
      }

      if (updates.legalAreas !== undefined) {
        try {
          updates.legalAreas = validateAreas(updates.legalAreas);
        } catch (err) {
          return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }
      if (updates.email) {
        updates.email = String(updates.email).trim().toLowerCase();
        if (!String(updates.email).includes("@")) {
          return res.status(400).json({ error: "Invalid email address." });
        }
      }

      updates.updatedAt = new Date().toISOString();
      updates.updatedBy = actor;

      await patch("providers", id, updates);
      log(`[providers] ${actor} updated provider ${id}`);
      const updated = await get("providers", id);
      return res.json({ success: true, provider: { id, ...updated } });
    }),
  );

  // DELETE /api/dashboard/providers/:id
  app.delete(
    "/api/dashboard/providers/:id",
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const actor = (req as Request & { sessionUser?: SessionUser }).sessionUser?.uid ?? "unknown";

      const existing = await get("providers", id);
      if (!existing) return res.status(404).json({ error: "Provider not found." });

      await del("providers", id);
      log(`[providers] ${actor} deleted provider ${id} (${existing.name})`);
      return res.json({ success: true, id });
    }),
  );
}