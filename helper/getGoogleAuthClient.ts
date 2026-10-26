import log from "./log.ts";

/**
 * Default scopes used by the application.
 *
 * NOTE: Each scope listed here MUST also be authorized in
 * Google Workspace Admin → Security → API Controls → Domain-wide delegation
 * for the service account's Client ID.
 *
 * Adding `drive.readonly` is required for fetching Gemini-generated
 * Google Meet notes (the notes are saved as Google Docs in Drive
 * and exported via the Drive `files.export` endpoint).
 */
export const DEFAULT_GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
];

export const getGoogleAccessToken = async (scopeOverride?: string[]) => {
  log("Parsing service account key...");
  const serviceAccountJson =
    Deno.env.get("CALENDAR_SERVICE_ACCOUNT_KEY") ||
    Deno.env.get("SERVICE_ACCOUNT_KEY");
  if (!serviceAccountJson) {
    throw new Error(
      "CALENDAR_SERVICE_ACCOUNT_KEY (or SERVICE_ACCOUNT_KEY) not set in environment.",
    );
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(serviceAccountJson);
  } catch (_error) {
    throw new Error("Failed to parse CALENDAR_SERVICE_ACCOUNT_KEY.");
  }

  const email = serviceAccount.client_email;
  const privateKey = serviceAccount.private_key;
  // P7: no built-in fallback (the old IRP address was one). Set it per deploy.
  const subject = (Deno.env.get("GOOGLE_SUBJECT_EMAIL") ?? "").trim();
  if (!subject) {
    throw new Error("GOOGLE_SUBJECT_EMAIL is not set (the Workspace user the service account acts as).");
  }

  const scopes = (scopeOverride && scopeOverride.length > 0
    ? scopeOverride
    : DEFAULT_GOOGLE_SCOPES
  ).join(" ");
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: email,
    scope: scopes,
    aud: "https://oauth2.googleapis.com/token",
    sub: subject,
    iat: now,
    exp: now + 3600,
  };

  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claim));
  const input = `${header}.${payload}`;

  log("Importing private key for signing...");
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(input)
  );

  const signature = b64url(String.fromCharCode(...new Uint8Array(sig)));
  const jwt = `${input}.${signature}`;

  log("Exchanging JWT for access token...");
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    log(`Failed to obtain access token: ${errorText}`);
    throw new Error(`Failed to obtain access token: ${errorText}`);
  }

  const { access_token } = await response.json();
  log("Access token obtained.");
  return access_token;
};

function b64url(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const pemHeader = "-----BEGIN PRIVATE KEY-----";
  const pemFooter = "-----END PRIVATE KEY-----";
  const pemContents = pem
    .replace(pemHeader, "")
    .replace(pemFooter, "")
    .trim()
    .replace(/\s+/g, "");
  const binaryDerString = atob(pemContents);
  const binaryDer = new Uint8Array(binaryDerString.length);
  for (let i = 0; i < binaryDerString.length; i++) {
    binaryDer[i] = binaryDerString.charCodeAt(i);
  }
  return binaryDer.buffer;
}