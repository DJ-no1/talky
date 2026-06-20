import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { AUTH_DIR } from "./config";

/**
 * WhatsApp now addresses many chats by LID (e.g. 124245216596056@lid) instead of the
 * phone JID (916291233974@s.whatsapp.net) — they are the same person, but a plain
 * string allowlist match on one form misses the other. Baileys persists the mapping
 * in wa_auth/:
 *   lid-mapping-<phoneDigits>.json          → "<lidDigits>"
 *   lid-mapping-<lidDigits>_reverse.json    → "<phoneDigits>"
 * These helpers expose cached sync lookups so policy checks can treat both forms as
 * equivalent without an async round-trip to the socket.
 */

const cache = new Map<string, { value: string | null; at: number }>();
const CACHE_TTL_MS = 60_000;

function readMappingFile(fileName: string): string | null {
  try {
    const filePath = path.join(AUTH_DIR, fileName);
    if (!existsSync(filePath)) return null;
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
    if (typeof raw !== "string") return null;
    const digits = raw.split(":")[0]?.trim() ?? "";
    return /^\d+$/.test(digits) ? digits : null;
  } catch {
    return null;
  }
}

function cachedLookup(key: string, fileName: string): string | null {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;
  const value = readMappingFile(fileName);
  cache.set(key, { value, at: now });
  return value;
}

/** Phone digits → LID digits, or null when the session has no mapping yet. */
export function lidDigitsForPhone(phoneDigits: string): string | null {
  if (!/^\d+$/.test(phoneDigits)) return null;
  return cachedLookup(`pn:${phoneDigits}`, `lid-mapping-${phoneDigits}.json`);
}

/** LID digits → phone digits, or null when the session has no mapping yet. */
export function phoneDigitsForLid(lidDigits: string): string | null {
  if (!/^\d+$/.test(lidDigits)) return null;
  return cachedLookup(`lid:${lidDigits}`, `lid-mapping-${lidDigits}_reverse.json`);
}
