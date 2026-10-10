import getAccessToken from "./getAccessToken.ts";

/**
 * fetch() with a cached Google OAuth bearer token attached, for Firestore REST.
 * Same shape as IRP-funnel's fetchWithAuth.
 */
export default async function fetchWithAuth(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getAccessToken();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return await fetch(url, { ...init, headers });
}