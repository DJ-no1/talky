import type { MemoryItem } from "./types";
import { appendMemoryLocal, searchMemoryLocal } from "./storage";
import {
  countChunks,
  hybridSearch,
  indexChunk,
  openMemoryDb,
  rebuildFromMarkdown
} from "./memory-db";
import type { EmbeddingProvider } from "./embeddings";

type Mem0SearchResponse =
  | {
      memories?: Array<{ memory?: string; score?: number; metadata?: Record<string, unknown> }>;
    }
  | Array<{ memory?: string; score?: number; metadata?: Record<string, unknown> }>;

export type MemoryServiceOptions = {
  mem0ApiKey?: string;
  embeddings?: EmbeddingProvider;
  backend?: "hybrid" | "legacy";
};

export class MemoryService {
  private readonly mem0ApiKey: string | undefined;
  private readonly embeddings: EmbeddingProvider | undefined;
  private readonly backend: "hybrid" | "legacy";
  private indexInitialized = false;

  constructor(options: MemoryServiceOptions | string | undefined) {
    if (typeof options === "string" || options === undefined) {
      this.mem0ApiKey = options || undefined;
      this.embeddings = undefined;
      this.backend = "legacy";
    } else {
      this.mem0ApiKey = options.mem0ApiKey;
      this.embeddings = options.embeddings;
      this.backend = options.backend ?? "hybrid";
    }
  }

  async ensureReady(): Promise<void> {
    if (this.backend !== "hybrid" || this.indexInitialized) return;
    this.indexInitialized = true;
    try {
      openMemoryDb();
      if (countChunks() === 0) {
        const embedFn = this.embeddings?.enabled
          ? (text: string) => this.embeddings!.embed(text)
          : undefined;
        await rebuildFromMarkdown(embedFn);
      }
    } catch {
      // ignore init errors; fall back to legacy token search
    }
  }

  async remember(userId: string, text: string, source: string): Promise<void> {
    const item: MemoryItem = { fact: text, confidence: 0.7, source };
    appendMemoryLocal(userId, item);

    if (this.backend === "hybrid") {
      try {
        const embedding = this.embeddings?.enabled
          ? (await this.embeddings.embed(text)) ?? undefined
          : undefined;
        indexChunk({
          jid: userId,
          sourceType: source || "chat_auto",
          sourceRef: `${Date.now()}`,
          text,
          importance: 0.6,
          embedding
        });
      } catch {
        // DB insert failure is non-fatal — markdown is source of truth
      }
    }

    if (!this.mem0ApiKey) return;
    try {
      await fetch("https://api.mem0.ai/v1/memories", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Token ${this.mem0ApiKey}`
        },
        body: JSON.stringify({
          user_id: userId,
          messages: [{ role: "user", content: text }],
          metadata: { source }
        })
      });
    } catch {
      // local fallback already succeeded
    }
  }

  async retrieve(userId: string, query: string, limit: number): Promise<MemoryItem[]> {
    await this.ensureReady();

    const hybrid = this.backend === "hybrid" ? await this.hybridRetrieve(userId, query, limit) : [];
    const primary = hybrid.length > 0 ? hybrid : searchMemoryLocal(userId, query, limit);

    if (!this.mem0ApiKey) return primary;

    try {
      const response = await fetch("https://api.mem0.ai/v1/memories/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Token ${this.mem0ApiKey}`
        },
        body: JSON.stringify({
          user_id: userId,
          query,
          limit
        })
      });

      if (!response.ok) return primary;
      const data = (await response.json()) as Mem0SearchResponse;
      const list = Array.isArray(data) ? data : data.memories ?? [];
      const mapped: MemoryItem[] = list
        .map((item) => ({
          fact: item.memory ?? "",
          confidence: Number(item.score ?? 0.6),
          source: "mem0"
        }))
        .filter((item) => item.fact.length > 0);

      if (mapped.length === 0) return primary;
      return mergeUnique(primary, mapped, limit);
    } catch {
      return primary;
    }
  }

  private async hybridRetrieve(
    userId: string,
    query: string,
    limit: number
  ): Promise<MemoryItem[]> {
    try {
      const queryEmbedding = this.embeddings?.enabled
        ? (await this.embeddings.embed(query)) ?? undefined
        : undefined;
      const chunks = hybridSearch({
        jid: userId,
        query,
        queryEmbedding,
        limit
      });
      return chunks.map((chunk) => ({
        fact: chunk.text,
        confidence: clamp01(chunk.combinedScore),
        source: `hybrid:${chunk.sourceType}`
      }));
    } catch {
      return [];
    }
  }
}

function mergeUnique(primary: MemoryItem[], extra: MemoryItem[], limit: number): MemoryItem[] {
  const seen = new Set<string>();
  const out: MemoryItem[] = [];
  for (const item of [...primary, ...extra]) {
    const key = item.fact.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
