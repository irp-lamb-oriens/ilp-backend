/**
 * API/referrals/crypto.ts — seal partner bank details at rest.
 *
 * AES-256-GCM with REFERRALS_BANK_KEY (32 bytes, base64; generate with
 * `openssl rand -base64 32`). Without the key, saving bank details answers 503
 * in production; in dev (no RENDER_EXTERNAL_URL) a fixed dev key is used so
 * the flow can be tried locally. Rotating the key makes old details unreadable:
 * partners re-enter them.
 */
import { ReferralError } from "./links.ts";

const DEV_KEY = "aWxwLWRldi1vbmx5LXJlZmVycmFscy1iYW5rLWtleSE="; // 32 bytes, dev only

function keyB64(): string {
  const k = Deno.env.get("REFERRALS_BANK_KEY")?.trim();
  if (k) return k;
  if (Deno.env.get("RENDER_EXTERNAL_URL")) {
    throw new ReferralError(503, "Bank details cannot be saved yet: REFERRALS_BANK_KEY is not set on the server.");
  }
  return DEV_KEY;
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function key(): Promise<CryptoKey> {
  const raw = unb64(keyB64());
  if (raw.length !== 32) throw new ReferralError(503, "REFERRALS_BANK_KEY must be 32 bytes, base64.");
  return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(data: Record<string, unknown>): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), new TextEncoder().encode(JSON.stringify(data))));
  return `v1:${b64(iv)}:${b64(ct)}`;
}

export async function unseal(sealed: string): Promise<Record<string, unknown>> {
  const [v, iv, ct] = String(sealed ?? "").split(":");
  if (v !== "v1" || !iv || !ct) throw new ReferralError(500, "Unreadable bank details.");
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await key(), unb64(ct));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    throw new ReferralError(500, "Bank details cannot be read with the current key. Ask the partner to enter them again.");
  }
}

/** Last 4 visible characters of an account, IBAN or phone. */
export function maskOf(account: string): string {
  const clean = String(account ?? "").replace(/[\s-]/g, "");
  return clean.length <= 4 ? "••••" : `••••${clean.slice(-4)}`;
}
