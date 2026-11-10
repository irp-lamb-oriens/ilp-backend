/**
 * API/referrals/links.ts — referral codes, UTM tags, tracked URLs. Pure.
 */
import type { Brand, PartnerType, UTM } from "./types.ts";

export const REF_PARAM = "ref";

const RESERVED = new Set([
  "admin", "api", "www", "status", "join", "check", "lawyer", "lawyers", "dashboard", "csm", "partners", "r",
  "pricing", "legal", "privacy", "terms", "ilp", "irp", "aiva", "censo",
]);

/** "Sara Elena Mora Ñúñez" → "sara-elena-mora-nunez" (ASCII, ≤ 32). */
export function slugify(input: string): string {
  return String(input ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
}

export function randomSuffix(len = 4): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export function isValidCode(code: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/.test(code) && !RESERVED.has(code);
}

/** Bare slug, then slug-brand, then slug-xxxx. `taken` answers whether a code exists. */
export async function generateCode(
  base: string,
  brand: Brand,
  taken: (code: string) => Promise<boolean>,
  preferred?: string,
): Promise<string> {
  if (preferred) {
    const p = slugify(preferred);
    if (!isValidCode(p)) throw new ReferralError(400, "That code is not allowed. Use 3-40 letters, numbers or dashes.");
    if (await taken(p)) throw new ReferralError(409, `The code "${p}" is already used.`);
    return p;
  }
  const slug = slugify(base).slice(0, 27).replace(/-+$/g, "") || "partner";
  for (const c of [slug, `${slug}-${brand}`]) {
    if (isValidCode(c) && !(await taken(c))) return c;
  }
  for (let i = 0; i < 20; i++) {
    const c = `${slug}-${randomSuffix()}`;
    if (isValidCode(c) && !(await taken(c))) return c;
  }
  throw new ReferralError(500, "Could not generate a free code. Try a custom one.");
}

const utmPart = (s: string) => slugify(s).slice(0, 64) || "partners";

export function mediumFor(type: PartnerType): string {
  return type === "referrer" ? "referral" : type;
}

export function buildUtm(type: PartnerType, code: string, campaign?: string, content?: string): UTM {
  return {
    source: code,
    medium: mediumFor(type),
    campaign: utmPart(campaign || "partners"),
    ...(content ? { content: utmPart(content) } : {}),
  };
}

/** Destination + ?ref=code&utm_*. Keeps other params and the hash. */
export function buildTrackedUrl(destination: string, code: string, utm: UTM): string {
  const u = new URL(destination);
  u.searchParams.set(REF_PARAM, code);
  u.searchParams.set("utm_source", utm.source);
  u.searchParams.set("utm_medium", utm.medium);
  u.searchParams.set("utm_campaign", utm.campaign);
  if (utm.content) u.searchParams.set("utm_content", utm.content);
  else u.searchParams.delete("utm_content");
  return u.toString();
}

/**
 * Landing hosts per brand. A link can only point at its brand's sites, so a
 * short link is never an open redirect. Override with REFERRAL_HOSTS_<BRAND>
 * (comma list, e.g. REFERRAL_HOSTS_IRP=internationalrelocationpartner.com).
 */
const DEFAULT_HOSTS: Record<Brand, string[]> = {
  ilp: ["internationallegalpartner.com"],
  irp: ["internationalrelocationpartner.com"],
  aiva: [],
  censo: ["elcenso.com"],
};

export function allowedHosts(brand: Brand): string[] {
  const env = Deno.env.get(`REFERRAL_HOSTS_${brand.toUpperCase()}`);
  const list = env ? env.split(/[,\s]+/).map((h) => h.trim().toLowerCase()).filter(Boolean) : DEFAULT_HOSTS[brand];
  return list;
}

export function checkDestination(destination: string, brand: Brand, hosts = allowedHosts(brand)): string {
  let u: URL;
  try {
    u = new URL(String(destination ?? "").trim());
  } catch {
    throw new ReferralError(400, "Enter the full page address, starting with https://");
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && u.hostname === "localhost")) {
    throw new ReferralError(400, "The page address must start with https://");
  }
  const host = u.hostname.toLowerCase();
  if (!hosts.length) throw new ReferralError(400, `No website is set for ${brand.toUpperCase()} yet (REFERRAL_HOSTS_${brand.toUpperCase()}).`);
  const ok = host === "localhost" || hosts.some((h) => host === h || host.endsWith(`.${h}`));
  if (!ok) throw new ReferralError(400, `Links for ${brand.toUpperCase()} must point to ${hosts.join(" or ")}.`);
  return u.toString();
}

export class ReferralError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ReferralError";
    this.status = status;
  }
}
