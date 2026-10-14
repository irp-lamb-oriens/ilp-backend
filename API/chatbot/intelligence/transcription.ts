/**
 * ILP — Legal Assistant audio transcription (OpenAI Whisper).
 * Uses Deno-native fetch; no npm deps.
 */

import { OPENAI_API_KEY } from "../config.ts";

const OPENAI_BASE_URL = "https://api.openai.com/v1";

export async function transcribeAudio(
  audio: Uint8Array,
  filename = "audio.webm",
): Promise<string> {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const form = new FormData();
  form.append("model", "whisper-1");
  // Copy into a fresh ArrayBuffer so the BlobPart type is a plain ArrayBuffer
  // (the incoming Uint8Array may be backed by a SharedArrayBuffer).
  const bytes = new Uint8Array(audio);
  form.append(
    "file",
    new Blob([bytes.buffer], { type: "audio/webm" }),
    filename,
  );

  const res = await fetch(`${OPENAI_BASE_URL}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Transcription failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  const text: string | undefined = data?.text;
  if (!text) {
    throw new Error("Transcription response missing text");
  }
  return text;
}