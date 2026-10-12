/**
 * ILP — Legal Assistant Config
 * Centralized env vars, constants, feature flags.
 */

function env(key: string, fallback?: string): string {
  const value = Deno.env.get(key) || fallback;
  if (!value) {
    console.warn(`[ILP-CONFIG] Missing env var: ${key}`);
    return "";
  }
  return value;
}

// ── OpenAI (LLM + Audio Transcription) ──────────────
export const OPENAI_API_KEY = env("OPENAI_API_KEY");
export const OPENAI_MODEL = env("OPENAI_MODEL", "gpt-4o-mini");

// ── Firebase / Firestore ────────────────────────────
export const FIREBASE_PROJECT_ID = env("FIREBASE_PROJECT_ID", "ilp");
export const FIRESTORE_BASE_URL =
  `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

// ── Google Calendar ─────────────────────────────────
export const CALENDAR_ID = env("CALENDAR_ID");
export const SERVICE_ACCOUNT_KEY = env("SERVICE_ACCOUNT_KEY");
export const GOOGLE_SUBJECT_EMAIL = env("GOOGLE_SUBJECT_EMAIL");

// ── Feature flags ───────────────────────────────────
export const CHATBOT_ENABLED = env("CHATBOT_ENABLED", "true") === "true";
export const SCHEDULING_ENABLED = env("SCHEDULING_ENABLED", "true") === "true";