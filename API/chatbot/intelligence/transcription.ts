/**
 * ILP — Legal Assistant audio transcription.
 *
 * Mirrors IRP-funnel's dashboard voice transcription: Gemini 2.5 Flash via
 * OpenRouter (multimodal `input_audio`), using the dedicated
 * `OPENROUTER_KEY_VOICE` key with a fallback to `OPENROUTER_API_KEY`.
 *
 * The public `transcribeAudio(audio, filename)` signature is preserved so the
 * existing `/api/dashboard/voice-transcribe` route and
 * `config/integrations.ts` keep working unchanged.
 */

import log from "../../../helper/log.ts";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

function openRouterKey(): string {
  return Deno.env.get("OPENROUTER_KEY_VOICE") || Deno.env.get("OPENROUTER_API_KEY") || "";
}

/** Convert a byte array to a base64 string without blowing the call stack. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Map a filename to the short format label OpenRouter expects in input_audio. */
function formatFromFilename(filename: string): string {
  const clean = (filename || "audio.webm").split(";")[0].toLowerCase();
  if (clean.includes("ogg")) return "ogg";
  if (clean.includes("mp4")) return "mp4";
  if (clean.includes("mpeg") || clean.includes("mp3")) return "mp3";
  if (clean.includes("wav")) return "wav";
  return "webm";
}

export async function transcribeAudio(
  audio: Uint8Array,
  filename = "audio.webm",
): Promise<string> {
  const orKey = openRouterKey();
  if (!orKey) {
    throw new Error("OPENROUTER_KEY_VOICE is not configured");
  }

  const audioBase64 = bytesToBase64(audio);
  const fmt = formatFromFilename(filename);
  const approxBytes = audio.length;

  log(`[voice-transcribe] → Gemini 2.5 Flash via OpenRouter | ~${approxBytes} bytes | fmt:${fmt}`);

  const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${orKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://ilp-backend-nlbz.onrender.com",
      "X-Title": "ILP Voice Transcription",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [{
        role: "user",
        content: [
          {
            type: "text",
            text: "Transcribe this audio recording verbatim into English text. Output only the spoken words — no commentary, no timestamps, no speaker labels.",
          },
          {
            type: "input_audio",
            input_audio: { data: audioBase64, format: fmt },
          },
        ],
      }],
      max_tokens: 4096,
    }),
  });

  if (!res.ok) {
    let errBody: string;
    try {
      errBody = JSON.stringify(await res.json());
    } catch {
      errBody = await res.text();
    }
    log(`[voice-transcribe] Gemini/OpenRouter error (${res.status}): ${errBody}`);
    throw new Error(`Transcription failed (${res.status}): ${errBody}`);
  }

  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const transcript = (data.choices?.[0]?.message?.content || "").trim();
  if (!transcript) {
    throw new Error("Transcription response missing text");
  }

  log(`[voice-transcribe] Transcribed ~${approxBytes} bytes → ${transcript.length} chars`);
  return transcript;
}