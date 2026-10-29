/**
 * API/journeys/outreach.ts — outbound contact records and their tracked links.
 * ──────────────────────────────────────────────────────────────────────────
 * An Outreach is created when staff send an outreach email (trigger-email),
 * import leads (bulk import commit) or log a CSM call / manual send
 * (POST /api/dashboard/journeys/outreach). Links in the email go through
 * GET /api/journey/c/:id?to=<site path> (click, then a redirect to an
 * allowlisted site path with ?o=<id>); an open pixel is GET
 * /api/journey/o/:id.gif. The email address is stored only as a SHA-256 hash.
 */

import get from "../../db/get.ts";
import patch from "../../db/patch.ts";
import { clean } from "../../db/records.ts";
import log from "../../helper/log.ts";
import {
  COLLECTIONS,
  JOURNEY_TRACK_FIELD,
  type JourneyTrack,
  OUTREACH_PARAM,
  type Outreach,
  type OutreachChannel,
  type OutreachCreated,
} from "../../schemas/contracts.ts";
import { getOutreach, patchOutreach, saveOutreach } from "./store.ts";
import { emailHash, syntheticVisitor, trackServerStep } from "./track.ts";
import { newOutreachId, safeRedirectPath } from "./validate.ts";

type Doc = Record<string, unknown>;

export const OUTREACH_CHANNELS: readonly OutreachChannel[] = ["email_outreach", "import", "csm_call"];
const CAMPAIGN_RE = /^[a-z0-9][a-z0-9._-]{0,59}$/;

export const siteUrl = () => (Deno.env.get("FRONTEND_URL") || Deno.env.get("PUBLIC_SITE_URL") || "http://localhost:3000").replace(/\/$/, "");
export const apiUrl = () => (Deno.env.get("PUBLIC_API_URL") || Deno.env.get("RENDER_EXTERNAL_URL") || "http://localhost:8000").replace(/\/$/, "");

/** A campaign name as a slug ("CR retirees Nov" → "cr-retirees-nov"); null when nothing is left. */
export function campaignSlug(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return CAMPAIGN_RE.test(s) ? s : null;
}

export function trackedUrls(outreachId: string, to = "/check"): Omit<OutreachCreated, "outreach"> {
  const path = safeRedirectPath(to);
  return {
    link: `${siteUrl()}${path}?${OUTREACH_PARAM}=${encodeURIComponent(outreachId)}`,
    clickUrl: `${apiUrl()}/api/journey/c/${encodeURIComponent(outreachId)}?to=${encodeURIComponent(path)}`,
    pixelUrl: `${apiUrl()}/api/journey/o/${encodeURIComponent(outreachId)}.gif`,
  };
}

/**
 * Pure: route the email's links to the site through the click redirect and
 * add the open pixel. Links elsewhere (mailto, other sites) are left alone.
 */
export function tagEmailHtml(html: string, outreachId: string, site = siteUrl(), api = apiUrl()): string {
  const esc = site.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`href=(["'])${esc}(/[^"'#?]*)?([?#][^"']*)?\\1`, "g");
  let out = html.replace(re, (_m, q: string, path: string | undefined) => {
    const p = safeRedirectPath(path || "/");
    return `href=${q}${api}/api/journey/c/${encodeURIComponent(outreachId)}?to=${encodeURIComponent(p)}${q}`;
  });
  const pixel = `<img src="${api}/api/journey/o/${encodeURIComponent(outreachId)}.gif" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">`;
  out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${pixel}</body>`) : out + pixel;
  return out;
}

export interface CreateOutreach {
  channel: OutreachChannel;
  campaign: string;
  sentBy: string;
  clientId?: string;
  leadId?: string;
  email?: string;
  at?: string;
  placeholder?: boolean;
}

/**
 * Create the outreach record, mark the person as outbound (when they had no
 * browser journey yet) and record outreach_sent.
 */
export async function createOutreach(input: CreateOutreach): Promise<Outreach> {
  const at = input.at ?? new Date().toISOString();
  const o: Outreach = {
    id: newOutreachId(input.placeholder),
    email: input.email ? await emailHash(input.email) : "",
    channel: input.channel,
    campaign: input.campaign,
    sentBy: input.sentBy,
    sentAt: at,
  };
  if (input.clientId) o.clientId = input.clientId;
  if (input.leadId) o.leadId = input.leadId;
  if (input.placeholder) o.placeholder = true;
  await saveOutreach(o);
  const who = input.clientId ? { clientId: input.clientId } : input.leadId ? { leadId: input.leadId } : null;
  if (who) {
    const col = who.clientId ? COLLECTIONS.clients : COLLECTIONS.leads;
    const id = (who.clientId ?? (who as { leadId: string }).leadId);
    try {
      const doc = (await get(col, id).catch(() => null)) as Doc | null;
      if (doc && !doc[JOURNEY_TRACK_FIELD]) {
        const track: JourneyTrack = { visitorId: await syntheticVisitor(`${col}/${id}`), source: "outbound", channel: input.channel, outreachId: o.id, firstAt: at };
        await patch(col, id, { [JOURNEY_TRACK_FIELD]: clean(track) });
      }
    } catch (err) {
      log(`[journeys] outreach person link failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }
  await trackServerStep("outreach_sent", who ?? {}, { outreachId: o.id, at, dedupe: o.id });
  return o;
}

/** Open pixel hit: first open only. Never throws. */
export async function recordOpen(id: string): Promise<boolean> {
  try {
    const o = await getOutreach(id);
    if (!o) return false;
    if (!o.openedAt) {
      const at = new Date().toISOString();
      await patchOutreach(id, { openedAt: at });
      await trackServerStep("outreach_opened", personOf(o), { outreachId: id, at, dedupe: id });
    }
    return true;
  } catch {
    return false;
  }
}

/** Click: first click only (an unseen open is implied). Never throws. */
export async function recordClick(id: string): Promise<boolean> {
  try {
    const o = await getOutreach(id);
    if (!o) return false;
    if (!o.clickedAt) {
      const at = new Date().toISOString();
      await patchOutreach(id, { clickedAt: at, ...(o.openedAt ? {} : { openedAt: at }) });
      if (!o.openedAt) await trackServerStep("outreach_opened", personOf(o), { outreachId: id, at, dedupe: id });
      await trackServerStep("outreach_clicked", personOf(o), { outreachId: id, at, dedupe: id });
    }
    return true;
  } catch {
    return false;
  }
}

const personOf = (o: Outreach) => (o.clientId ? { clientId: o.clientId } : o.leadId ? { leadId: o.leadId } : {});

/** Outreach as staff see it (the email hash stays server-side). */
export function outreachView(o: Outreach): Omit<Outreach, "email"> {
  const { email: _email, ...rest } = o;
  return rest;
}

/** 1×1 transparent GIF. */
export const PIXEL_GIF = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (c) => c.charCodeAt(0));
