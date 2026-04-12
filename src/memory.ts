import type { MemoryItem } from "./types";
import { appendMemoryLocal, searchMemoryLocal } from "./storage";

type Mem0SearchResponse =
  | {
      memories?: Array<{ memory?: string; score?: number; metadata?: Record<string, unknown> }>;
    }
  | Array<{ memory?: string; score?: number; metadata?: Record<string, unknown> }>;

export class MemoryService {
  constructor(private readonly mem0ApiKey: string | undefined) {}

  async remember(userId: string, text: string, source: string): Promise<void> {
    const item: MemoryItem = { fact: text, confidence: 0.7, source };
    appendMemoryLocal(userId, item);
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
      // Local fallback already succeeded.
    }
  }

  async retrieve(userId: string, query: string, limit: number): Promise<MemoryItem[]> {
    const local = searchMemoryLocal(userId, query, limit);
    if (!this.mem0ApiKey) return local;

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

      if (!response.ok) return local;
      const data = (await response.json()) as Mem0SearchResponse;
      const list = Array.isArray(data) ? data : data.memories ?? [];
      const mapped = list
        .map((item) => ({
          fact: item.memory ?? "",
          confidence: Number(item.score ?? 0.6),
          source: "mem0"
        }))
        .filter((item) => item.fact.length > 0);

      if (mapped.length === 0) return local;
      return mapped.slice(0, limit);
    } catch {
      return local;
    }
  }
}
