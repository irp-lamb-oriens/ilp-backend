/**
 * config/push.ts — Web Push (RFC 8291) delivery for ILP.
 * ──────────────────────────────────────────────────────────────────────────
 * Sends browser push notifications to subscribed clients. Implemented natively
 * on WebCrypto (no `web-push` npm dependency) so it runs identically under
 * Deno and the browser, matching the existing WebCrypto JWT signing in
 * helper/getAccessToken.ts.
 *
 * Protocol pieces:
 *   • VAPID (RFC 8292) — a P-256 ECDSA keypair identifies the server. The
 *     public key is exposed to the browser so it can subscribe; the private
 *     key signs a short JWT (ES256) sent on every push.
 *   • Payload encryption (RFC 8291 + RFC 8188) — the notification body is
 *     encrypted with AES-128-GCM using a key derived from an ECDH exchange
 *     between an ephemeral server key and the subscription's `p256dh`.
 *
 * VAPID keys are read from env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY) so they
 * stay stable across restarts. When unset, a keypair is generated in-memory
 * (fine for local dev; subscriptions must be re-created if the key changes).
 */

import log from "../helper/log.ts";

const VAPID_SUBJECT =
  Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@internationallegalpartner.com";

/** A browser push subscription as returned by `pushManager.subscribe()`. */
export interface PushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

// ── Base64url helpers ────────────────────────────────────────────────────────

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const buffer = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const buffer = new ArrayBuffer(total);
  const out = new Uint8Array(buffer);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Copy any Uint8Array into a fresh ArrayBuffer-backed one. */
function toArrayBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(bytes.length);
  const out = new Uint8Array(buffer);
  out.set(bytes);
  return out;
}

// ── VAPID keypair ────────────────────────────────────────────────────────────

let vapidCache: {
  publicKey: string;
  privateKey: string;
  keyPair: CryptoKeyPair;
} | null = null;

async function importVapidPublicKey(b64: string): Promise<CryptoKey> {
  const raw = b64urlToBytes(b64);
  return await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

async function importVapidPrivateKey(b64: string): Promise<CryptoKey> {
  // The VAPID private key is a full PKCS#8 DER structure (base64url), so it
  // imports directly as "pkcs8".
  const pkcs8 = b64urlToBytes(b64);
  return await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

async function exportVapidPublicKey(key: CryptoKey): Promise<string> {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  return b64url(raw);
}

async function exportVapidPrivateKey(key: CryptoKey): Promise<string> {
  const jwk = await crypto.subtle.exportKey("jwk", key);
  if (!jwk.d) throw new Error("VAPID private key export failed (no d).");
  return jwk.d;
}

async function getVapidKeyPair(): Promise<CryptoKeyPair> {
  if (vapidCache) return vapidCache.keyPair;

  const envPub = Deno.env.get("VAPID_PUBLIC_KEY");
  const envPriv = Deno.env.get("VAPID_PRIVATE_KEY");

  if (envPub && envPriv) {
    const publicKey = await importVapidPublicKey(envPub);
    const privateKey = await importVapidPrivateKey(envPriv);
    vapidCache = { publicKey: envPub, privateKey: envPriv, keyPair: { publicKey, privateKey } };
    return vapidCache.keyPair;
  }

  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await exportVapidPublicKey(keyPair.publicKey);
  const privateKey = await exportVapidPrivateKey(keyPair.privateKey);
  vapidCache = { publicKey, privateKey, keyPair };
  log(
    "[push] VAPID keys generated in-memory. Set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY for stable keys.",
    "push",
  );
  return keyPair;
}

/** The VAPID public key (base64url) the browser needs to subscribe. */
export async function getVapidPublicKey(): Promise<string> {
  await getVapidKeyPair();
  return vapidCache!.publicKey;
}

// ── VAPID JWT (ES256) ────────────────────────────────────────────────────────

function encodeJson(obj: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

async function signVapidJwt(
  audience: string,
  keyPair: CryptoKeyPair,
): Promise<string> {
  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: VAPID_SUBJECT,
  };
  const signingInput = `${encodeJson(header)}.${encodeJson(payload)}`;
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keyPair.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

// ── Payload encryption (RFC 8291 / RFC 8188) ────────────────────────────────

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

async function encryptPayload(
  plaintext: Uint8Array<ArrayBuffer>,
  subscription: PushSubscription,
): Promise<Uint8Array<ArrayBuffer>> {
  // 1. Ephemeral ECDH keypair.
  const ephemeral = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );

  // 2. Import the subscription's p256dh public key.
  const uaPublic = await crypto.subtle.importKey(
    "raw",
    b64urlToBytes(subscription.keys.p256dh),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );

  // 3. ECDH shared secret.
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: uaPublic },
      ephemeral.privateKey,
      256,
    ),
  );

  // 4. Derive the content encryption key + nonce (RFC 8291 §3.4).
  const authSecret = b64urlToBytes(subscription.keys.auth);
  const asPublic = new Uint8Array(
    await crypto.subtle.exportKey("raw", ephemeral.publicKey),
  );
  const uaPublicRaw = b64urlToBytes(subscription.keys.p256dh);

  const prkKey = await hkdf(authSecret, ecdhSecret, new Uint8Array(0), 32);

  const keyInfo = concatBytes(
    new TextEncoder().encode("WebPush: info"),
    new Uint8Array([0x00]),
    uaPublicRaw,
    asPublic,
  );
  const ikm = await hkdf(new Uint8Array(0), prkKey, keyInfo, 32);

  const cek = ikm.slice(0, 16);
  const nonce = ikm.slice(16, 28);

  // 5. AES-128-GCM encrypt.
  const cekKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
    "encrypt",
  ]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, tagLength: 128 },
      cekKey,
      plaintext,
    ),
  );

  // 6. Salt (16 bytes) + ephemeral public key (65 bytes) + ciphertext+tag.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return concatBytes(salt, asPublic, ciphertext);
}

// ── Send ─────────────────────────────────────────────────────────────────────

/**
 * Send a push notification to a single subscription. Returns true on success.
 * A 404/410 means the subscription is gone and should be removed by the caller.
 */
export async function sendPushNotification(
  subscription: PushSubscription,
  payload: { title: string; body: string; url?: string },
): Promise<{ ok: boolean; gone: boolean }> {
  const keyPair = await getVapidKeyPair();
  const audience = new URL(subscription.endpoint).origin;

  const jwt = await signVapidJwt(audience, keyPair);
  const publicKey = await getVapidPublicKey();

  const body = await encryptPayload(
    toArrayBuffer(new TextEncoder().encode(JSON.stringify(payload))),
    subscription,
  );

  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${jwt}, k=${publicKey}`,
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      TTL: "86400",
    },
    body,
  });

  if (res.status === 404 || res.status === 410) {
    return { ok: false, gone: true };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    log(`[push] send failed (${res.status}): ${text}`, "push");
    return { ok: false, gone: false };
  }
  return { ok: true, gone: false };
}