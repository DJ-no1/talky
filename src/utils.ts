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
