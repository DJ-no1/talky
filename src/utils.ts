import crypto from "node:crypto";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomBetween(min: number, max: number): number {
  if (max <= min) return min;
  const value = crypto.randomInt(min, max + 1);
  return value;
}

export function sanitizeJid(jid: string): string {
  return jid.replace(/[^a-zA-Z0-9@._-]/g, "_");
}

export function compactText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export function tokenOverlapScore(text: string, query: string): number {
  const a = new Set(text.toLowerCase().split(/\W+/).filter(Boolean));
  const b = new Set(query.toLowerCase().split(/\W+/).filter(Boolean));
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of b) {
    if (a.has(token)) overlap += 1;
  }
  return overlap / b.size;
}

/** Jaccard similarity on word tokens (length > 2), used for memory deduplication. */
export function jaccardTokenSimilarity(a: string, b: string): number {
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
