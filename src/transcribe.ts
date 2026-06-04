/**
 * Voice note transcription with cascading fallback:
 *   1. Groq Whisper (primary  — permanent free tier, 2k req/day, OGG native)
 *   2. Gladia       (secondary — 10 h/month recurring free, OGG/Opus native)
 *   3. Gemini       (fallback  — multimodal, but burns daily quota fast)
 *
 * Set GROQ_API_KEY and/or GLADIA_API_KEY in .env to enable the free tiers.
 * Gemini is always available as a last resort when the Gemini key is present.
 */

import type { AppEnv } from "./types";
import type { GeminiClient } from "./gemini";

const GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GLADIA_UPLOAD_URL   = "https://api.gladia.io/v2/upload";
const GLADIA_STT_URL      = "https://api.gladia.io/v2/pre-recorded";

/** Transcribe a WhatsApp audio buffer. Returns transcript string or empty string on total failure. */
export async function transcribeAudio(
  bytes: Buffer,
  mimeType: string,
  opts: {
    env: AppEnv;
    gemini: GeminiClient;
    geminiModel: string;
    onLog?: (msg: string) => void;
  }
): Promise<string> {
  const { env, gemini, geminiModel, onLog } = opts;
  const log = onLog ?? (() => undefined);
  const ext = extForMime(mimeType);

  if (env.groqApiKey) {
    try {
      const result = await groqTranscribe(bytes, mimeType, ext, env.groqApiKey);
      if (result) { log("groq"); return result; }
    } catch (err) {
      log(`groq failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (env.gladiaApiKey) {
    try {
      const result = await gladiaTranscribe(bytes, mimeType, ext, env.gladiaApiKey);
      if (result) { log("gladia"); return result; }
    } catch (err) {
      log(`gladia failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Gemini fallback
  try {
    const mimeNorm = normalizeGeminiMime(mimeType);
    const result = await gemini.generate({
      model: geminiModel,
      systemInstruction:
        "You are a WhatsApp voice note transcriber. Transcribe the audio exactly as spoken. Output only the plain transcription — no quotes, no commentary.",
      parts: [
        { text: "Transcribe this voice note:" },
        { inline_data: { mime_type: mimeNorm, data: bytes.toString("base64") } }
      ],
      temperature: 0.0,
      maxOutputTokens: 300
    });
    if (result) { log("gemini-fallback"); return result.trim().slice(0, 600); }
  } catch (err) {
    log(`gemini fallback failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return "";
}

async function groqTranscribe(
  bytes: Buffer,
  mimeType: string,
  ext: string,
  apiKey: string
): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: mimeType }), `audio${ext}`);
  form.append("model", "whisper-large-v3-turbo");
  form.append("response_format", "text");

  const res = await fetch(GROQ_TRANSCRIBE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  });

  if (res.status === 429) throw new Error(`groq rate limited (429)`);
  if (!res.ok) throw new Error(`groq HTTP ${res.status}`);

  // response_format=text returns plain text
  const text = await res.text();
  return text.trim().slice(0, 600);
}

async function gladiaTranscribe(
  bytes: Buffer,
  mimeType: string,
  ext: string,
  apiKey: string
): Promise<string> {
  // Step 1: upload
  const uploadForm = new FormData();
  uploadForm.append("audio", new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: mimeType }), `audio${ext}`);

  const uploadRes = await fetch(GLADIA_UPLOAD_URL, {
    method: "POST",
    headers: { "x-gladia-key": apiKey },
    body: uploadForm
  });
  if (!uploadRes.ok) throw new Error(`gladia upload HTTP ${uploadRes.status}`);
  const { audio_url } = (await uploadRes.json()) as { audio_url: string };
  if (!audio_url) throw new Error("gladia upload returned no audio_url");

  // Step 2: transcribe
  const sttRes = await fetch(GLADIA_STT_URL, {
    method: "POST",
    headers: { "x-gladia-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ audio_url })
  });
  if (!sttRes.ok) throw new Error(`gladia STT HTTP ${sttRes.status}`);
  const { id: transcriptionId } = (await sttRes.json()) as { id: string };
  if (!transcriptionId) throw new Error("gladia returned no transcription id");

  // Step 3: poll (up to 30 s)
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    const pollRes = await fetch(`${GLADIA_STT_URL}/${transcriptionId}`, {
      headers: { "x-gladia-key": apiKey }
    });
    if (!pollRes.ok) continue;
    const data = (await pollRes.json()) as {
      status?: string;
      result?: { transcription?: { full_transcript?: string } };
    };
    if (data.status === "done" || data.status === "processed") {
      const t = data.result?.transcription?.full_transcript ?? "";
      return t.trim().slice(0, 600);
    }
    if (data.status === "error") throw new Error("gladia transcription error");
  }
  throw new Error("gladia transcription timed out");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extForMime(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  const map: Record<string, string> = {
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/wav": ".wav",
    "audio/webm": ".webm",
    "audio/flac": ".flac"
  };
  return map[base] ?? ".ogg";
}

function normalizeGeminiMime(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "audio/ogg";
  // Gemini accepts audio/ogg but not audio/ogg; codecs=opus — strip params
  return base || "audio/ogg";
}
