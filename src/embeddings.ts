import { GoogleGenAI } from "@google/genai";

export type EmbeddingProvider = {
  readonly id: string;
  readonly dimension: number;
  readonly enabled: boolean;
  embed(text: string): Promise<Float32Array | null>;
  embedBatch(texts: string[]): Promise<Array<Float32Array | null>>;
};

const DEFAULT_MODEL = "text-embedding-004";
const EMBED_DIM = 768;
const MAX_BATCH = 64;
const MAX_INPUT_CHARS = 8_000;

export function createEmbeddingProvider(
  apiKey: string | undefined,
  opts?: { model?: string; dimension?: number }
): EmbeddingProvider {
  if (!apiKey) return noopProvider();

  const client = new GoogleGenAI({ apiKey });
  const model = opts?.model ?? DEFAULT_MODEL;
  const dimension = opts?.dimension ?? EMBED_DIM;

  const cache = new Map<string, Float32Array>();

  async function embedOne(text: string): Promise<Float32Array | null> {
    const normalized = normalizeInput(text);
    if (!normalized) return null;
    const cached = cache.get(normalized);
    if (cached) return cached;

    try {
      const response = (await client.models.embedContent({
        model,
        contents: [{ role: "user", parts: [{ text: normalized }] }]
      })) as unknown as EmbedContentResponse;

      const values = extractVector(response);
      if (!values || values.length === 0) return null;
      const vec = new Float32Array(values);
      if (cache.size > 500) {
        const firstKey = cache.keys().next().value;
        if (firstKey !== undefined) cache.delete(firstKey);
      }
      cache.set(normalized, vec);
      return vec;
    } catch {
      return null;
    }
  }

  async function embedBatch(texts: string[]): Promise<Array<Float32Array | null>> {
    const results: Array<Float32Array | null> = new Array(texts.length).fill(null);
    for (let start = 0; start < texts.length; start += MAX_BATCH) {
      const slice = texts.slice(start, start + MAX_BATCH);
      const settled = await Promise.all(slice.map((t) => embedOne(t)));
      for (let i = 0; i < settled.length; i += 1) {
        results[start + i] = settled[i] ?? null;
      }
    }
    return results;
  }

  return {
    id: `gemini:${model}`,
    dimension,
    enabled: true,
    embed: embedOne,
    embedBatch
  };
}

function noopProvider(): EmbeddingProvider {
  return {
    id: "none",
    dimension: 0,
    enabled: false,
    async embed() {
      return null;
    },
    async embedBatch(texts) {
      return texts.map(() => null);
    }
  };
}

function normalizeInput(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (trimmed.length <= MAX_INPUT_CHARS) return trimmed;
  return trimmed.slice(0, MAX_INPUT_CHARS);
}

type EmbedContentResponse = {
  embedding?: { values?: number[] } | null;
  embeddings?: Array<{ values?: number[] }> | null;
};

function extractVector(response: EmbedContentResponse | null | undefined): number[] | null {
  if (!response) return null;
  const single = response.embedding?.values;
  if (Array.isArray(single) && single.length > 0) return single;
  const first = response.embeddings?.[0]?.values;
  if (Array.isArray(first) && first.length > 0) return first;
  return null;
}
