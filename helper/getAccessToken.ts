/**
 * Obtains a Google OAuth2 access token for the service account using the
 * JWT-bearer flow (RS256). The assertion JWT is signed with native WebCrypto
 * (no djwt dependency needed for signing), then exchanged at Google's token
 * endpoint. Mirrors the IRP-funnel `getAccessToken` behavior.
 */

let cachedToken: string | null = null;
let cachedExpiry = 0;

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = "https://www.googleapis.com/auth/datastore";

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

function readServiceAccount(): ServiceAccount {
  const raw = Deno.env.get("SERVICE_ACCOUNT_KEY");
  if (!raw) throw new Error("SERVICE_ACCOUNT_KEY is not set.");

  const expanded = raw.startsWith("~")
    ? raw.replace(/^~/, Deno.env.get("HOME") ?? "/root")
    : raw;

  const parsed = expanded.trim().startsWith("{")
    ? JSON.parse(expanded)
    : JSON.parse(Deno.readTextFileSync(expanded));

  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("Service account key is missing `client_email` or `private_key`.");
  }
  return parsed as ServiceAccount;
}

/** Import a PEM PKCS#8 private key for RS256 signing. */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const der = pemToArrayBuffer(pem);
  return await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer as ArrayBuffer;
}

function base64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeJson(obj: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(obj)));
}

/** Sign a JWT assertion using RS256 and return the compact token. */
async function signJwt(
  payload: Record<string, unknown>,
  key: CryptoKey,
): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const signingInput = `${encodeJson(header)}.${encodeJson(payload)}`;
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64Url(new Uint8Array(sig))}`;
}

export default async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedExpiry > Date.now() + 60_000) {
    return cachedToken;
  }

  const sa = readServiceAccount();
  const key = await importPrivateKey(sa.private_key);
  const now = Math.floor(Date.now() / 1000);

  const assertion = await signJwt({
    iss: sa.client_email,
    scope: SCOPES,
    aud: sa.token_uri ?? TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }, key);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to get access token: ${res.status} ${body}`);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  cachedToken = data.access_token;
  cachedExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}