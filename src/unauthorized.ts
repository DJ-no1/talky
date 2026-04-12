import { join } from "path";
import { readFileSync, writeFileSync, existsSync } from "fs";

const UNAUTHORIZED_FILE = join(process.cwd(), "data", "unauthorized-candidates.json");

export type UnauthorizedCandidate = {
  jid: string;
  kind: "direct" | "group";
  firstSeen: string;
  lastSeen: string;
  count: number;
  lastReason: string;
  name: string; // best-effort pushName or group name
};

function readStore(): Record<string, UnauthorizedCandidate> {
  if (!existsSync(UNAUTHORIZED_FILE)) {
      return {};
  }
  try {
      return JSON.parse(readFileSync(UNAUTHORIZED_FILE, "utf-8"));
  } catch {
      return {};
  }
}

function writeStore(store: Record<string, UnauthorizedCandidate>) {
  writeFileSync(UNAUTHORIZED_FILE, JSON.stringify(store, null, 2), "utf-8");
}

export function recordUnauthorized(jid: string, isGroup: boolean, reason: string, pushName?: string) {
  const store = readStore();
  const existing = store[jid];
  const now = new Date().toISOString();

  if (existing) {
      existing.count += 1;
      existing.lastSeen = now;
      existing.lastReason = reason;
      if (pushName && !existing.name) existing.name = pushName;
  } else {
      store[jid] = {
          jid,
          kind: isGroup ? "group" : "direct",
          firstSeen: now,
          lastSeen: now,
          count: 1,
          lastReason: reason,
          name: pushName || ""
      };
  }
  writeStore(store);
}

export function getUnauthorizedCandidates(): UnauthorizedCandidate[] {
  const store = readStore();
  return Object.values(store).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

export function removeUnauthorizedCandidate(jid: string): void {
  const store = readStore();
  if (store[jid]) {
      delete store[jid];
      writeStore(store);
  }
}
