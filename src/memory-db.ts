import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DATA_DIR, MEMORY_DIR } from "./config";
import { sanitizeJid } from "./utils";

export type MemoryChunkRow = {
  id: number;
  jid: string;
  sourceType: string;
  sourceRef: string;
  chunkIndex: number;
  text: string;
  importance: number;
  createdAt: string;
  meta: Record<string, unknown>;
};

export type ScoredMemoryChunk = MemoryChunkRow & {
  bm25Score: number;
  vectorScore: number;
  combinedScore: number;
};

export type HybridSearchOptions = {
  jid?: string;
  query: string;
  queryEmbedding?: Float32Array;
  limit?: number;
  bm25Weight?: number;
  vectorWeight?: number;
  recencyHalfLifeDays?: number;
  candidatePool?: number;
};

const DB_PATH = path.join(DATA_DIR, "memory.db");
const DEFAULT_CANDIDATE_POOL = 60;
const DEFAULT_LIMIT = 10;
const DEFAULT_BM25_WEIGHT = 0.3;
const DEFAULT_VECTOR_WEIGHT = 0.7;
const DEFAULT_RECENCY_HALF_LIFE_DAYS = 45;

let sharedDb: Database | null = null;

export function openMemoryDb(): Database {
  if (sharedDb) return sharedDb;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      chunk_index INTEGER NOT NULL DEFAULT 0,
      text TEXT NOT NULL,
      importance REAL NOT NULL DEFAULT 0.5,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      embedding BLOB,
      embedding_dim INTEGER,
      meta TEXT NOT NULL DEFAULT '{}',
      UNIQUE(jid, source_type, source_ref, chunk_index)
    )
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_memory_chunks_jid ON memory_chunks(jid)");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_memory_chunks_source ON memory_chunks(source_type, source_ref)"
  );

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      text,
      content='memory_chunks',
      content_rowid='id',
      tokenize='porter unicode61'
    )
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memory_chunks_ai AFTER INSERT ON memory_chunks BEGIN
      INSERT INTO memory_fts(rowid, text) VALUES (new.id, new.text);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memory_chunks_ad AFTER DELETE ON memory_chunks BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, text) VALUES('delete', old.id, old.text);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memory_chunks_au AFTER UPDATE ON memory_chunks BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, text) VALUES('delete', old.id, old.text);
      INSERT INTO memory_fts(rowid, text) VALUES (new.id, new.text);
    END
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  sharedDb = db;
  return db;
}

export function closeMemoryDb(): void {
  if (sharedDb) {
    try {
      sharedDb.close();
    } catch {
      // ignore
    }
    sharedDb = null;
  }
}

export type IndexChunkInput = {
  jid: string;
  sourceType: "chat_auto" | "persona" | "self_chat" | "summary" | "imported" | string;
  sourceRef: string;
  chunkIndex?: number;
  text: string;
  importance?: number;
  embedding?: Float32Array;
  meta?: Record<string, unknown>;
  createdAtISO?: string;
};

export function indexChunk(input: IndexChunkInput): number {
  const db = openMemoryDb();
  const text = input.text.trim();
  if (!text) return 0;

  const embeddingBlob = input.embedding ? float32ToBlob(input.embedding) : null;
  const embeddingDim = input.embedding ? input.embedding.length : null;
  const metaJson = JSON.stringify(input.meta ?? {});
  const createdAt = input.createdAtISO ?? new Date().toISOString();
  const chunkIndex = input.chunkIndex ?? 0;
  const importance = clamp(input.importance ?? 0.5, 0, 1);

  const stmt = db.prepare(`
    INSERT INTO memory_chunks (jid, source_type, source_ref, chunk_index, text, importance, embedding, embedding_dim, meta, created_at)
    VALUES ($jid, $sourceType, $sourceRef, $chunkIndex, $text, $importance, $embedding, $embeddingDim, $meta, $createdAt)
    ON CONFLICT(jid, source_type, source_ref, chunk_index) DO UPDATE SET
      text = excluded.text,
      importance = excluded.importance,
      embedding = excluded.embedding,
      embedding_dim = excluded.embedding_dim,
      meta = excluded.meta,
      created_at = excluded.created_at
    RETURNING id
  `);

  const row = stmt.get({
    $jid: input.jid,
    $sourceType: input.sourceType,
    $sourceRef: input.sourceRef,
    $chunkIndex: chunkIndex,
    $text: text,
    $importance: importance,
    $embedding: embeddingBlob,
    $embeddingDim: embeddingDim,
    $meta: metaJson,
    $createdAt: createdAt
  }) as { id: number } | null;

  return row?.id ?? 0;
}

export function indexChunksBatch(inputs: IndexChunkInput[]): number {
  if (inputs.length === 0) return 0;
  const db = openMemoryDb();
  let inserted = 0;
  const tx = db.transaction((items: IndexChunkInput[]) => {
    for (const item of items) {
      const id = indexChunk(item);
      if (id > 0) inserted += 1;
    }
  });
  tx(inputs);
  return inserted;
}

export function deleteChunksByJid(jid: string): number {
  const db = openMemoryDb();
  const result = db.prepare("DELETE FROM memory_chunks WHERE jid = ?").run(jid);
  return Number(result.changes ?? 0);
}

export function deleteChunksBySource(sourceType: string, sourceRef: string): number {
  const db = openMemoryDb();
  const result = db
    .prepare("DELETE FROM memory_chunks WHERE source_type = ? AND source_ref = ?")
    .run(sourceType, sourceRef);
  return Number(result.changes ?? 0);
}

export function countChunks(jid?: string): number {
  const db = openMemoryDb();
  if (jid) {
    const row = db.prepare("SELECT COUNT(*) AS n FROM memory_chunks WHERE jid = ?").get(jid) as
      | { n: number }
      | null;
    return row?.n ?? 0;
  }
  const row = db.prepare("SELECT COUNT(*) AS n FROM memory_chunks").get() as { n: number } | null;
  return row?.n ?? 0;
}

export function hybridSearch(options: HybridSearchOptions): ScoredMemoryChunk[] {
  const db = openMemoryDb();
  const limit = options.limit ?? DEFAULT_LIMIT;
  const candidatePool = Math.max(limit, options.candidatePool ?? DEFAULT_CANDIDATE_POOL);
  const bm25Weight = options.bm25Weight ?? DEFAULT_BM25_WEIGHT;
  const vectorWeight = options.vectorWeight ?? DEFAULT_VECTOR_WEIGHT;
  const halfLifeDays = options.recencyHalfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS;
  const query = options.query.trim();

  const candidates = new Map<number, MemoryChunkRow & { bm25Score: number; vectorScore: number }>();

  const ftsQuery = buildFtsMatch(query);
  if (ftsQuery) {
    const jidClause = options.jid ? "AND m.jid = $jid" : "";
    const sql = `
      SELECT m.*, bm25(memory_fts) AS bm25_raw
      FROM memory_fts
      JOIN memory_chunks m ON m.id = memory_fts.rowid
      WHERE memory_fts MATCH $q
        ${jidClause}
      ORDER BY bm25_raw ASC
      LIMIT $limit
    `;

    const params: Record<string, unknown> = {
      $q: ftsQuery,
      $limit: candidatePool
    };
    if (options.jid) params.$jid = options.jid;

    try {
      const rows = db.prepare(sql).all(params as never) as Array<Record<string, unknown>>;
      let bestBm25 = 0;
      const collected: Array<{ row: Record<string, unknown>; bm25Raw: number }> = [];
      for (const row of rows) {
        const bm25Raw = Number(row.bm25_raw ?? 0);
        const positive = bm25Raw <= 0 ? -bm25Raw : 0;
        if (positive > bestBm25) bestBm25 = positive;
        collected.push({ row, bm25Raw });
      }
      for (const { row, bm25Raw } of collected) {
        const chunk = mapRow(row);
        const positive = bm25Raw <= 0 ? -bm25Raw : 0;
        const normalized = bestBm25 > 0 ? positive / bestBm25 : 0;
        candidates.set(chunk.id, { ...chunk, bm25Score: normalized, vectorScore: 0 });
      }
    } catch {
      // FTS query malformed — fall back to vector-only or LIKE fallback below
    }
  }

  if (options.queryEmbedding && options.queryEmbedding.length > 0) {
    const jidClause = options.jid ? "WHERE jid = $jid" : "";
    const sql = `
      SELECT *
      FROM memory_chunks
      ${jidClause}
      ${jidClause ? "AND" : "WHERE"} embedding IS NOT NULL
    `;
    const params: Record<string, unknown> = {};
    if (options.jid) params.$jid = options.jid;

    try {
      const rows = db.prepare(sql).all(params as never) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const chunk = mapRow(row);
        const embedding = blobToFloat32(row.embedding as ArrayBuffer | Uint8Array | null);
        if (!embedding) continue;
        if (embedding.length !== options.queryEmbedding.length) continue;
        const sim = cosineSimilarity(embedding, options.queryEmbedding);
        const existing = candidates.get(chunk.id);
        if (existing) {
          existing.vectorScore = Math.max(existing.vectorScore, sim);
        } else {
          candidates.set(chunk.id, { ...chunk, bm25Score: 0, vectorScore: sim });
        }
      }
    } catch {
      // ignore
    }
  }

  if (candidates.size === 0 && query) {
    const jidClause = options.jid ? "AND jid = $jid" : "";
    const sql = `
      SELECT *
      FROM memory_chunks
      WHERE text LIKE $q
      ${jidClause}
      ORDER BY created_at DESC
      LIMIT $limit
    `;
    const params: Record<string, unknown> = {
      $q: `%${query.slice(0, 80)}%`,
      $limit: candidatePool
    };
    if (options.jid) params.$jid = options.jid;
    try {
      const rows = db.prepare(sql).all(params as never) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const chunk = mapRow(row);
        candidates.set(chunk.id, { ...chunk, bm25Score: 0.2, vectorScore: 0 });
      }
    } catch {
      // ignore
    }
  }

  const now = Date.now();
  const scored: ScoredMemoryChunk[] = [];
  for (const chunk of candidates.values()) {
    const recency = recencyMultiplier(chunk.createdAt, now, halfLifeDays);
    const importanceBoost = 0.85 + chunk.importance * 0.3;
    const combined =
      (bm25Weight * chunk.bm25Score + vectorWeight * chunk.vectorScore) *
      recency *
      importanceBoost;
    scored.push({
      ...chunk,
      combinedScore: combined
    });
  }

  scored.sort((a, b) => b.combinedScore - a.combinedScore);
  return dedupeMMR(scored, limit, 0.82);
}

export type RebuildStats = {
  filesScanned: number;
  chunksIndexed: number;
  errors: number;
};

export function rebuildFromMarkdown(
  embedFn?: (text: string) => Promise<Float32Array | null>
): Promise<RebuildStats> {
  return rebuildFromMarkdownInternal(embedFn);
}

async function rebuildFromMarkdownInternal(
  embedFn?: (text: string) => Promise<Float32Array | null>
): Promise<RebuildStats> {
  const stats: RebuildStats = { filesScanned: 0, chunksIndexed: 0, errors: 0 };
  if (!existsSync(MEMORY_DIR)) return stats;

  const files = readdirSync(MEMORY_DIR).filter((f) => f.endsWith(".md"));
  for (const file of files) {
    const fullPath = path.join(MEMORY_DIR, file);
    const jid = file.replace(/\.md$/, "");
    try {
      const raw = readFileSync(fullPath, "utf-8");
      const lines = raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("- "));

      const stat = statSync(fullPath);
      deleteChunksBySource("persona_md", jid);

      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        const fact = extractFactFromLine(line);
        if (!fact) continue;

        let embedding: Float32Array | undefined;
        if (embedFn) {
          try {
            const vec = await embedFn(fact);
            if (vec) embedding = vec;
          } catch {
            // fallthrough — store without embedding
          }
        }

        indexChunk({
          jid,
          sourceType: "persona_md",
          sourceRef: jid,
          chunkIndex: i,
          text: fact,
          importance: 0.5,
          embedding,
          createdAtISO: stat.mtime.toISOString()
        });
        stats.chunksIndexed += 1;
      }
      stats.filesScanned += 1;
    } catch {
      stats.errors += 1;
    }
  }
  return stats;
}

export function dbPath(): string {
  return DB_PATH;
}

function buildFtsMatch(query: string): string {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && t.length <= 40);
  if (tokens.length === 0) return "";
  const unique = Array.from(new Set(tokens)).slice(0, 8);
  return unique.map((token) => `${token}*`).join(" OR ");
}

function mapRow(row: Record<string, unknown>): MemoryChunkRow {
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(String(row.meta ?? "{}")) as Record<string, unknown>;
  } catch {
    meta = {};
  }
  return {
    id: Number(row.id ?? 0),
    jid: String(row.jid ?? ""),
    sourceType: String(row.source_type ?? ""),
    sourceRef: String(row.source_ref ?? ""),
    chunkIndex: Number(row.chunk_index ?? 0),
    text: String(row.text ?? ""),
    importance: Number(row.importance ?? 0.5),
    createdAt: String(row.created_at ?? ""),
    meta
  };
}

function float32ToBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

function blobToFloat32(blob: ArrayBuffer | Uint8Array | null): Float32Array | null {
  if (!blob) return null;
  if (blob instanceof Uint8Array) {
    if (blob.byteLength % 4 !== 0) return null;
    return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  }
  if (blob instanceof ArrayBuffer) {
    if (blob.byteLength % 4 !== 0) return null;
    return new Float32Array(blob);
  }
  return null;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let aSq = 0;
  let bSq = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    aSq += av * av;
    bSq += bv * bv;
  }
  if (aSq === 0 || bSq === 0) return 0;
  return dot / (Math.sqrt(aSq) * Math.sqrt(bSq));
}

function recencyMultiplier(createdAt: string, nowMs: number, halfLifeDays: number): number {
  const parsed = Date.parse(createdAt);
  if (!Number.isFinite(parsed)) return 0.85;
  const ageDays = Math.max(0, (nowMs - parsed) / (1000 * 60 * 60 * 24));
  const decay = Math.pow(0.5, ageDays / Math.max(1, halfLifeDays));
  return 0.6 + 0.4 * decay;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function extractFactFromLine(line: string): string {
  const trimmed = line.startsWith("- ") ? line.slice(2) : line;
  const parts = trimmed.split(" | ");
  if (parts.length >= 4) return parts.slice(3).join(" | ").trim();
  return trimmed.trim();
}

function dedupeMMR(
  scored: ScoredMemoryChunk[],
  limit: number,
  similarityThreshold: number
): ScoredMemoryChunk[] {
  if (scored.length <= limit) return scored.slice(0, limit);
  const picked: ScoredMemoryChunk[] = [];
  for (const candidate of scored) {
    if (picked.length >= limit) break;
    const tooSimilar = picked.some(
      (existing) => jaccardSimilarity(existing.text, candidate.text) >= similarityThreshold
    );
    if (!tooSimilar) picked.push(candidate);
  }
  if (picked.length < limit) {
    for (const candidate of scored) {
      if (picked.length >= limit) break;
      if (!picked.includes(candidate)) picked.push(candidate);
    }
  }
  return picked;
}

function jaccardSimilarity(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/\W+/).filter((t) => t.length > 2));
  const tb = new Set(b.toLowerCase().split(/\W+/).filter((t) => t.length > 2));
  if (ta.size === 0 || tb.size === 0) return 0;
  let overlap = 0;
  for (const token of ta) {
    if (tb.has(token)) overlap += 1;
  }
  const union = ta.size + tb.size - overlap;
  return union === 0 ? 0 : overlap / union;
}
