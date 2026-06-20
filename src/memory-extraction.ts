import type { GeminiClient } from "./gemini";
import { compactText } from "./utils";

export type MemoryExtractResult = {
  store: boolean;
  fact: string;
  confidence: number;
};

function tryParseJsonObject(raw: string): unknown {
  const t = raw.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const payload = fence?.[1]?.trim() ?? t;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/**
 * Gemini pass: decide whether a chat line is worth durable memory and canonicalize wording.
 */
export async function classifyMessageForMemory(
  client: GeminiClient,
  model: string,
  message: string,
  hints: { senderJid: string; isGroup: boolean; chatLabel?: string }
): Promise<MemoryExtractResult | null> {
  const text = compactText(message);
  if (!text || text.length > 500) return null;

  const prompt = [
    "You label WhatsApp snippets for personal long-term memory.",
    `Chat: ${hints.isGroup ? "group" : "direct"}.${hints.chatLabel ? ` Context: ${hints.chatLabel}.` : ""}`,
    "",
    `Message:\n"""${text}"""`,
    "",
    'Reply with ONE JSON object only, no markdown. Keys: "store" (boolean), "fact" (string or null), "confidence" (0 to 1 number).',
    'Set store=true only for durable facts: preferences, commitments, scheduled events, names, or explicit "remember this".',
    "Set store=false for jokes, small talk, questions without answers, or anything not useful later.",
    "When store=true, fact must be a single short third-person or neutral sentence (no \"I\" unless quoting).",
    "When store=false, fact must be null."
  ].join("\n");

  try {
    const out = await client.generate({
      model,
      systemInstruction:
        "You output only valid JSON objects. Never add commentary before or after the JSON.",
      parts: [{ text: prompt }],
      temperature: 0.15,
      maxOutputTokens: 220
    });
    const parsed = tryParseJsonObject(out);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const rec = parsed as Record<string, unknown>;
    const store = Boolean(rec.store);
    const conf = typeof rec.confidence === "number" ? rec.confidence : 0.55;
    const factRaw = rec.fact;
    const fact =
      typeof factRaw === "string" ? compactText(factRaw) : factRaw == null ? "" : String(factRaw);

    if (!store || !fact) {
      return { store: false, fact: "", confidence: Math.min(1, Math.max(0, conf)) };
    }
    return { store: true, fact, confidence: Math.min(1, Math.max(0.2, conf)) };
  } catch {
    return null;
  }
}
