/**
 * API/referrals/referralsRouter.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Partner referral program for every brand (ILP, IRP, AIVA, El Censo).
 *
 * Public
 *   GET  /api/referrals/resolve/:code              short link → { url } (counts the click)
 * Other brands' servers (header x-referrals-key: $REFERRALS_INGEST_KEY)
 *   POST /api/referrals/ingest/lead                { brand, clientId|email, refCode, refAt? }
 *   POST /api/referrals/ingest/sale                { brand, saleRef, clientId|email, amountCents, activationCents?, kind, paidAt?, refCode? }
 *   POST /api/referrals/ingest/refund              { brand, saleRef, reason }
 * Staff (dashboard session; CSMs read only; money and bank details admin only)
 *   GET  /api/dashboard/referrals/overview          ?year&brand
 *   GET  /api/dashboard/referrals/partners
 *   POST /api/dashboard/referrals/partners          { name, email, type, brands[], ruleIds{}, language, notes, startedAt?, sendInvite?, link? }
 *   GET  /api/dashboard/referrals/partners/:id
 *   PATCH /api/dashboard/referrals/partners/:id
 *   POST /api/dashboard/referrals/partners/:id/invite
 *   GET  /api/dashboard/referrals/partners/:id/payout-details      admin, audited
 *   POST /api/dashboard/referrals/partners/:id/payout-details      admin
 *   POST /api/dashboard/referrals/partners/:id/adjust              admin
 *   GET  /api/dashboard/referrals/rules             (+ presets)
 *   POST /api/dashboard/referrals/rules             admin
 *   POST /api/dashboard/referrals/rules/:id/archive admin { archived }
 *   POST /api/dashboard/referrals/links             { partnerId, brand, destination, campaign?, content?, code? }
 *   PATCH /api/dashboard/referrals/links/:id        { active }
 *   POST /api/dashboard/referrals/assign            { brand, clientId|email, partnerId, reason }
 *   POST /api/dashboard/referrals/sales             { brand, saleRef, clientId|email, amountCents, kind, paidAt?, refCode? }
 *   POST /api/dashboard/referrals/refunds           admin { brand, saleRef, reason }
 *   GET  /api/dashboard/referrals/payouts           preview + history
 *   POST /api/dashboard/referrals/payouts           admin { partnerId, reference, method?, paidAt?, notify? }
 *   POST /api/dashboard/referrals/import            admin { rows[] }
 * Partner portal (partner session, partnerAuth.ts)
 *   GET  /api/partner/me                            statement
 *   GET  /api/partner/me/links
 *   PATCH /api/partner/me                           { language?, monthlyEmail? }
 *   POST /api/partner/me/payout-details
 */
import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import log from "../../helper/log.ts";
import { type AuthedRequest, requireDashboardAuth } from "../../helper/auth/session.ts";
import { requireStaffRole } from "../../helper/auth/roles.ts";
import { timingSafeEqualStr } from "../../helper/auth/otp.ts";
import { enqueueEmail } from "../../helper/emailQueue.ts";
import { brandOrThrow, ReferralEngine, subjectFromEmail } from "./engine.ts";
import { allowedHosts, ReferralError } from "./links.ts";
import { RULE_PRESETS } from "./rules.ts";
import { type Actor, firestoreReferralStore, type ReferralStore } from "./store.ts";
import { partnerRows, partnerStatement, yearReport } from "./reports.ts";
import { partnerInviteEmail, payoutSentEmail } from "./emails.ts";
import { partnerAuthRoutes, type PartnerRequest, requirePartnerAuth } from "./partnerAuth.ts";
import { type Brand, BRANDS, type Partner, type SaleKind } from "./types.ts";

type Doc = Record<string, unknown>;

export const siteUrl = () => (Deno.env.get("PUBLIC_SITE_URL") || Deno.env.get("FRONTEND_URL") || "http://localhost:3000").replace(/\/$/, "");
export const partnerPortalUrl = () => `${siteUrl()}/partners`;

/** Never send sealed bank details to a browser. */
export function publicPartner(p: Partner) {
  const { payout, ...rest } = p;
  return { ...rest, ...(payout ? { payout: { method: payout.method, holderName: payout.holderName, bankName: payout.bankName, country: payout.country, currency: payout.currency, mask: payout.mask, updatedAt: payout.updatedAt } } : {}) };
}

const staffActor = (req: Request): Actor => {
  const r = req as AuthedRequest;
  return { uid: r.dashboardUser ?? "staff", email: r.dashboardUser ?? "staff", role: r.dashboardRole ?? "staff" };
};
const partnerActor = (req: Request): Actor => {
  const r = req as PartnerRequest;
  return { uid: r.partnerId ?? "partner", email: r.partnerEmail ?? "partner", role: "partner" };
};

/** Runs a handler and turns ReferralError into its status. */
const handle = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  asyncHandler(async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof ReferralError) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  });

function saleFrom(body: Doc, fallbackKind: SaleKind = "one_time") {
  const brand = brandOrThrow(body.brand);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const clientId = String(body.clientId ?? "").trim() || (email ? subjectFromEmail(email) : "");
  if (!clientId) throw new ReferralError(400, "Send clientId or email.");
  const amountCents = body.amountCents !== undefined ? Number(body.amountCents) : Math.round(Number(body.amount) * 100);
  const kind = (["initial", "renewal", "one_time"].includes(String(body.kind)) ? body.kind : fallbackKind) as SaleKind;
  return {
    brand,
    saleRef: String(body.saleRef ?? "").trim(),
    clientId,
    amountCents,
    ...(body.activationCents ? { activationCents: Number(body.activationCents) } : {}),
    kind,
    paidAt: typeof body.paidAt === "string" ? body.paidAt : new Date().toISOString(),
    ...(typeof body.refCode === "string" ? { refCode: body.refCode } : {}),
    ...(email ? { email } : {}),
  };
}

function ingestKeyOk(req: Request): boolean {
  const want = Deno.env.get("REFERRALS_INGEST_KEY") ?? "";
  const got = String(req.headers["x-referrals-key"] ?? "");
  return want.length >= 24 && timingSafeEqualStr(got, want);
}

const yearOf = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 2000 && n < 2100 ? n : new Date().getUTCFullYear();
};

export function registerReferralRoutes(app: Express, store: ReferralStore = firestoreReferralStore, engine = new ReferralEngine(store)) {
  // ─── Public ───
  app.get(
    "/api/referrals/resolve/:code",
    handle(async (req, res) => {
      const hit = await engine.resolveCode(String(req.params.code ?? ""));
      res.setHeader("Cache-Control", "no-store");
      if (!hit) return res.status(404).json({ error: "Unknown link." });
      res.json(hit);
    }),
  );

  // ─── Ingest (server to server) ───
  const ingest = (fn: (req: Request, res: Response) => Promise<unknown>) =>
    handle(async (req, res) => {
      if (!ingestKeyOk(req)) return res.status(401).json({ error: "Invalid ingest key." });
      await fn(req, res);
    });
  const INGEST = { uid: "ingest", email: "ingest", role: "system" };

  app.post("/api/referrals/ingest/lead", ingest(async (req, res) => {
    const b = (req.body ?? {}) as Doc;
    const r = await engine.attribute({
      brand: brandOrThrow(b.brand),
      clientId: typeof b.clientId === "string" ? b.clientId : undefined,
      email: typeof b.email === "string" ? b.email : undefined,
      refCode: typeof b.refCode === "string" ? b.refCode : undefined,
      refAt: typeof b.refAt === "string" ? b.refAt : undefined,
      via: "ingest",
    });
    res.json({ attributed: !!r, partnerId: r?.partnerId ?? null });
  }));
  app.post("/api/referrals/ingest/sale", ingest(async (req, res) => {
    const out = await engine.recordSale(saleFrom((req.body ?? {}) as Doc), INGEST);
    res.json({ reason: out.reason, commission: out.commission ? { id: out.commission.id, amountCents: out.commission.amountCents, status: out.commission.status } : null });
  }));
  app.post("/api/referrals/ingest/refund", ingest(async (req, res) => {
    const lines = await engine.refundSale((req.body ?? {}) as Doc as { brand: unknown; saleRef: unknown; reason: unknown }, INGEST);
    res.json({ lines: lines.length });
  }));

  // ─── Staff ───
  const S = "/api/dashboard/referrals";
  const anyStaff = [requireDashboardAuth];
  const editor = [requireDashboardAuth, requireStaffRole("staff")]; // staff + admin (not CSM)
  const admin = [requireDashboardAuth, requireStaffRole()]; // admin only

  app.get(`${S}/overview`, ...anyStaff, handle(async (req, res) => {
    const brand = req.query.brand ? brandOrThrow(req.query.brand) : undefined;
    const [report, partners, preview] = await Promise.all([
      yearReport(store, yearOf(req.query.year), { brand }),
      partnerRows(store),
      engine.previewPayouts(),
    ]);
    res.json({
      report,
      partners,
      payouts: {
        readyCount: preview.ready.length,
        readyCents: preview.ready.reduce((s, r) => s + r.totalCents, 0),
        heldCount: preview.held.length,
      },
      brands: BRANDS,
    });
  }));

  app.get(`${S}/partners`, ...anyStaff, handle(async (_req, res) => {
    res.json({ partners: await partnerRows(store) });
  }));

  app.post(`${S}/partners`, ...editor, handle(async (req, res) => {
    const b = (req.body ?? {}) as Doc;
    const actor = staffActor(req);
    const p = await engine.createPartner(b as Parameters<ReferralEngine["createPartner"]>[0], actor);
    let link = null;
    const l = b.link as Doc | undefined;
    if (l?.destination && l?.brand) {
      link = await engine.createLink({ partnerId: p.id, brand: l.brand, destination: l.destination, campaign: l.campaign, code: l.code }, actor);
    }
    if (b.sendInvite !== false) await sendInvite(p);
    res.status(201).json({ partner: publicPartner(p), link });
  }));

  app.get(`${S}/partners/:id`, ...anyStaff, handle(async (req, res) => {
    const p = await engine.mustPartner(String(req.params.id));
    const [statement, links, rules] = await Promise.all([
      partnerStatement(store, p.id, { year: yearOf(req.query.year) }),
      store.listLinks(p.id),
      store.listRules(),
    ]);
    res.json({ partner: publicPartner(p), statement, links: links.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), rules });
  }));

  app.patch(`${S}/partners/:id`, ...editor, handle(async (req, res) => {
    res.json({ partner: publicPartner(await engine.updatePartner(String(req.params.id), (req.body ?? {}) as Doc, staffActor(req))) });
  }));

  app.post(`${S}/partners/:id/invite`, ...editor, handle(async (req, res) => {
    const p = await engine.mustPartner(String(req.params.id));
    await sendInvite(p);
    await store.audit(staffActor(req), "referral.partner_invited", `referral_partners/${p.id}`);
    res.json({ sent: true });
  }));

  app.get(`${S}/partners/:id/payout-details`, ...admin, handle(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ details: await engine.revealPayoutDetails(String(req.params.id), staffActor(req)) });
  }));

  app.post(`${S}/partners/:id/payout-details`, ...admin, handle(async (req, res) => {
    res.json({ partner: publicPartner(await engine.setPayoutDetails(String(req.params.id), (req.body ?? {}) as Doc, staffActor(req))) });
  }));

  app.post(`${S}/partners/:id/adjust`, ...admin, handle(async (req, res) => {
    const b = (req.body ?? {}) as Doc;
    res.status(201).json({ commission: await engine.adjust({ ...b, partnerId: req.params.id } as Parameters<ReferralEngine["adjust"]>[0], staffActor(req)) });
  }));

  app.get(`${S}/rules`, ...anyStaff, handle(async (_req, res) => {
    const rules = (await store.listRules()).sort((a, b) => a.brand.localeCompare(b.brand) || a.name.localeCompare(b.name));
    const hosts = Object.fromEntries(BRANDS.map((b) => [b, allowedHosts(b)])) as Record<Brand, string[]>;
    res.json({ rules, presets: RULE_PRESETS, hosts });
  }));

  app.post(`${S}/rules`, ...admin, handle(async (req, res) => {
    res.status(201).json({ rule: await engine.createRule((req.body ?? {}) as Parameters<ReferralEngine["createRule"]>[0], staffActor(req)) });
  }));

  app.post(`${S}/rules/:id/archive`, ...admin, handle(async (req, res) => {
    res.json({ rule: await engine.archiveRule(String(req.params.id), (req.body ?? {}).archived !== false, staffActor(req)) });
  }));

  app.post(`${S}/links`, ...editor, handle(async (req, res) => {
    res.status(201).json({ link: await engine.createLink((req.body ?? {}) as Parameters<ReferralEngine["createLink"]>[0], staffActor(req)) });
  }));

  app.patch(`${S}/links/:id`, ...editor, handle(async (req, res) => {
    res.json({ link: await engine.setLinkActive(String(req.params.id), (req.body ?? {}).active !== false, staffActor(req)) });
  }));

  app.post(`${S}/assign`, ...editor, handle(async (req, res) => {
    res.json({ referral: await engine.assignManually((req.body ?? {}) as Parameters<ReferralEngine["assignManually"]>[0], staffActor(req)) });
  }));

  app.post(`${S}/sales`, ...editor, handle(async (req, res) => {
    const sale = saleFrom((req.body ?? {}) as Doc);
    if (!sale.saleRef) sale.saleRef = `manual:${sale.brand}:${sale.clientId}:${sale.paidAt}`;
    const out = await engine.recordSale(sale, staffActor(req));
    res.status(out.commission && out.reason === "earned" ? 201 : 200).json(out);
  }));

  app.post(`${S}/refunds`, ...admin, handle(async (req, res) => {
    res.json({ lines: await engine.refundSale((req.body ?? {}) as { brand: unknown; saleRef: unknown; reason: unknown }, staffActor(req)) });
  }));

  app.get(`${S}/payouts`, ...anyStaff, handle(async (_req, res) => {
    const [preview, history, partners] = await Promise.all([engine.previewPayouts(), store.listPayouts({}), store.listPartners()]);
    const names = new Map(partners.map((p) => [p.id, p.name]));
    res.json({
      ready: preview.ready.map((r) => ({ ...r, partner: publicPartner(r.partner) })),
      held: preview.held.map((r) => ({ ...r, partner: publicPartner(r.partner) })),
      history: history.sort((a, b) => b.paidAt.localeCompare(a.paidAt)).slice(0, 200).map((p) => ({ ...p, partnerName: names.get(p.partnerId) ?? p.partnerId, commissionIds: undefined, lines: p.commissionIds.length })),
      minPayoutCents: engine.minPayoutCents,
    });
  }));

  app.post(`${S}/payouts`, ...admin, handle(async (req, res) => {
    const b = (req.body ?? {}) as Doc;
    const payout = await engine.recordPayout(b as Parameters<ReferralEngine["recordPayout"]>[0], staffActor(req));
    if (b.notify !== false) {
      const p = await store.getPartner(payout.partnerId);
      if (p) {
        const lifetime = (await store.listPayouts({ partnerId: p.id })).reduce((s, x) => s + x.totalCents, 0);
        const mail = payoutSentEmail(p, payout.totalCents, payout.reference, partnerPortalUrl(), lifetime);
        await enqueueEmail({ to: p.email, subject: mail.subject, html: mail.html, text: mail.text }, `ref_payout_${payout.id}`)
          .catch((err) => log(`[referrals] payout email not queued: ${err}`, "error"));
      }
    }
    res.status(201).json({ payout });
  }));

  app.post(`${S}/import`, ...admin, handle(async (req, res) => {
    res.json(await engine.importHistory((req.body ?? {}).rows, staffActor(req)));
  }));

  // ─── Partner portal ───
  partnerAuthRoutes(app, store);
  const partner = requirePartnerAuth(store);

  app.get("/api/partner/me", partner, handle(async (req, res) => {
    const id = (req as PartnerRequest).partnerId!;
    res.json({ statement: await partnerStatement(store, id, { year: yearOf(req.query.year) }) });
  }));

  app.get("/api/partner/me/links", partner, handle(async (req, res) => {
    const links = await store.listLinks((req as PartnerRequest).partnerId!);
    res.json({ links: links.filter((l) => l.active).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(({ id, brand, code, url, destination, utm, clicks, createdAt }) => ({ id, brand, code, url, destination, campaign: utm.campaign, clicks, createdAt, shortUrl: `${siteUrl()}/r/${code}` })) });
  }));

  app.patch("/api/partner/me", partner, handle(async (req, res) => {
    const b = (req.body ?? {}) as Doc;
    const patch: Doc = {};
    if (b.language !== undefined) patch.language = b.language;
    if (b.monthlyEmail !== undefined) patch.monthlyEmail = b.monthlyEmail;
    const p = await engine.updatePartner((req as PartnerRequest).partnerId!, patch, partnerActor(req));
    res.json({ partner: publicPartner(p) });
  }));

  app.post("/api/partner/me/payout-details", partner, handle(async (req, res) => {
    const p = await engine.setPayoutDetails((req as PartnerRequest).partnerId!, (req.body ?? {}) as Doc, partnerActor(req));
    res.json({ partner: publicPartner(p) });
  }));

  async function sendInvite(p: Partner) {
    const mail = partnerInviteEmail(p, partnerPortalUrl());
    await enqueueEmail({ to: p.email, subject: mail.subject, html: mail.html, text: mail.text })
      .catch((err) => log(`[referrals] invite not queued for ${p.id}: ${err}`, "error"));
  }

  return engine;
}

export default function referralsRouter(app: Express) {
  log("Referrals router initialized.");
  registerReferralRoutes(app);
}
