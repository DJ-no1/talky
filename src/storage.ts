import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { CHAT_DIR, LOG_DIR, MEMORY_DIR } from "./config";
import type { MemoryItem, MessageRecord } from "./types";
import { sanitizeJid, tokenOverlapScore } from "./utils";

export type DebugLogEvent = {
  timestampISO: string;
  source: "decision" | "tool";
  chatJid?: string;
  senderJid?: string;
  tool?: string;
  decision?: string;
  ok?: boolean;
  message: string;
  raw: string;
};

function ensureFile(filePath: string, heading: string): void {
  if (!existsSync(filePath)) {
    writeFileSync(filePath, `${heading}\n\n`, "utf-8");
  }
}

export function appendChatHistory(record: MessageRecord): void {
  const filePath = path.join(CHAT_DIR, `${sanitizeJid(record.chatJid)}.md`);
  ensureFile(filePath, `# Chat: ${record.chatJid}`);
  const line = `- ${record.timestampISO} | ${record.role} | ${record.senderJid}\n  ${record.text}\n`;
  appendFileSync(filePath, line, "utf-8");
}

export function readRecentChatHistory(chatJid: string, limit: number): string[] {
  return parseChatEntries(chatJid)
    .slice(-limit)
    .map(
      (entry) =>
        `- ${entry.timestampISO} | ${entry.role} | ${entry.senderJid} | ${entry.text}`
    );
}

export function readRecentSenderMessages(
  chatJid: string,
  senderJid: string,
  limit: number
): string[] {
  return parseChatEntries(chatJid)
    .filter((entry) => entry.role === "incoming" && entry.senderJid === senderJid)
    .slice(-limit)
    .map((entry) => `${entry.timestampISO} | ${entry.text}`);
}

export function readRecentOutgoingMessages(chatJid: string, limit: number): string[] {
  return parseChatEntries(chatJid)
    .filter((entry) => entry.role === "outgoing")
    .slice(-limit)
    .map((entry) => `${entry.timestampISO} | ${entry.text}`);
}

export function appendDecisionLog(entry: string): void {
  const filePath = path.join(LOG_DIR, "decisions.md");
  ensureFile(filePath, "# Decision Log");
  appendFileSync(filePath, `- ${entry}\n`, "utf-8");
}

export function appendMemoryLocal(userId: string, memory: MemoryItem): void {
  const filePath = path.join(MEMORY_DIR, `${sanitizeJid(userId)}.md`);
  ensureFile(filePath, `# Memory: ${userId}`);
  const line = `- ${new Date().toISOString()} | confidence=${memory.confidence.toFixed(
    2
  )} | source=${memory.source} | ${memory.fact}\n`;
  appendFileSync(filePath, line, "utf-8");
}

export function listMemoryLocal(userId?: string): Record<string, string[]> {
  const rows: Record<string, string[]> = {};
  if (!existsSync(MEMORY_DIR)) return rows;
  if (userId) {
    const filePath = path.join(MEMORY_DIR, `${sanitizeJid(userId)}.md`);
    if (!existsSync(filePath)) return rows;
    rows[userId] = readFileSync(filePath, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- "));
    return rows;
  }

  for (const file of readdirSync(MEMORY_DIR)) {
    if (!file.endsWith(".md")) continue;
    const fullPath = path.join(MEMORY_DIR, file);
    const content = readFileSync(fullPath, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- "));
    rows[file.replace(/\.md$/, "")] = content;
  }
  return rows;
}

export function clearMemoryLocal(userId?: string): void {
  if (!existsSync(MEMORY_DIR)) return;
  if (userId) {
    const filePath = path.join(MEMORY_DIR, `${sanitizeJid(userId)}.md`);
    if (existsSync(filePath)) unlinkSync(filePath);
    return;
  }
  for (const file of readdirSync(MEMORY_DIR)) {
    if (file.endsWith(".md")) {
      unlinkSync(path.join(MEMORY_DIR, file));
    }
  }
}

export function exportMemoryLocalMarkdown(targetPath: string): string {
  if (!existsSync(MEMORY_DIR)) {
    writeFileSync(targetPath, "# Memory Export\n\nNo local memory found.\n", "utf-8");
    return targetPath;
  }

  const blocks: string[] = ["# Memory Export", `Generated: ${new Date().toISOString()}`, ""];
  for (const file of readdirSync(MEMORY_DIR)) {
    if (!file.endsWith(".md")) continue;
    const fullPath = path.join(MEMORY_DIR, file);
    const content = readFileSync(fullPath, "utf-8");
    blocks.push(`## ${file.replace(/\.md$/, "")}`);
    blocks.push(content);
    blocks.push("");
  }

  writeFileSync(targetPath, blocks.join("\n"), "utf-8");
  return targetPath;
}

export function searchMemoryLocal(userId: string, query: string, limit: number): MemoryItem[] {
  const filePath = path.join(MEMORY_DIR, `${sanitizeJid(userId)}.md`);
  if (!existsSync(filePath)) return [];
  const matches = readFileSync(filePath, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => {
      const fact = line.split(" | ").slice(3).join(" | ");
      const score = tokenOverlapScore(fact, query);
      return {
        fact,
        confidence: score,
        source: "local_md"
      } satisfies MemoryItem;
    })
    .filter((item) => item.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence);

  return matches.slice(0, limit);
}

export function listKnownDirectChatJidsFromLocal(): string[] {
  if (!existsSync(CHAT_DIR)) return [];
  const direct = new Set<string>();
  for (const file of readdirSync(CHAT_DIR)) {
    if (!file.endsWith(".md")) continue;
    const jid = file.replace(/\.md$/, "");
    if (
      jid.includes("@") &&
      !jid.endsWith("@g.us") &&
      jid !== "status@broadcast" &&
      !jid.endsWith("@broadcast")
    ) {
      direct.add(jid);
    }
  }
  return Array.from(direct).sort();
}

type ChatEntry = {
  timestampISO: string;
  role: "incoming" | "outgoing";
  senderJid: string;
  text: string;
};

export function readAllChatHistories(): Record<string, ChatEntry[]> {
  const result: Record<string, ChatEntry[]> = {};
  if (!existsSync(CHAT_DIR)) return result;
  
  for (const file of readdirSync(CHAT_DIR)) {
    if (!file.endsWith(".md")) continue;
    const jid = file.replace(/\.md$/, "");
    result[jid] = parseChatEntries(jid);
  }
  return result;
}

export function readChatHistoryRaw(chatJid: string): ChatEntry[] {
  return parseChatEntries(chatJid);
}

export function readDebugLogEvents(args?: {
  chatJid?: string;
  limit?: number;
}): DebugLogEvent[] {
  const limit = Math.min(500, Math.max(10, Math.floor(args?.limit ?? 250)));
  const targetChat = args?.chatJid?.trim();

  const events: DebugLogEvent[] = [];
  const toolLogPath = path.join(LOG_DIR, "tool-actions.md");
  const decisionLogPath = path.join(LOG_DIR, "decisions.md");

  events.push(...parseToolActionLog(toolLogPath));
  events.push(...parseDecisionLog(decisionLogPath));

  const filtered = targetChat
    ? events.filter((event) => event.chatJid === targetChat)
    : events;

  return filtered
    .sort((a, b) => {
      const left = Date.parse(a.timestampISO);
      const right = Date.parse(b.timestampISO);
      if (!Number.isFinite(left) && !Number.isFinite(right)) return 0;
      if (!Number.isFinite(left)) return 1;
      if (!Number.isFinite(right)) return -1;
      return right - left;
    })
    .slice(0, limit);
}

function parseChatEntries(chatJid: string): ChatEntry[] {
  const filePath = path.join(CHAT_DIR, `${sanitizeJid(chatJid)}.md`);
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split(/\r?\n/);
  const entries: ChatEntry[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!line.startsWith("- ")) continue;
    const meta = line.slice(2).split(" | ");
    if (meta.length < 3) continue;
    const timestampISO = (meta[0] ?? "").trim();
    const roleRaw = (meta[1] ?? "").trim();
    const senderJid = (meta[2] ?? "").trim();
    const rawNextLine = lines[i + 1] ?? "";
    const text = rawNextLine.startsWith("  ") ? rawNextLine.slice(2).trim() : rawNextLine.trim();
    if (roleRaw !== "incoming" && roleRaw !== "outgoing") continue;
    entries.push({
      timestampISO,
      role: roleRaw,
      senderJid,
      text: text || "[empty]"
    });
  }

  return entries;
}

function parseToolActionLog(filePath: string): DebugLogEvent[] {
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, "utf-8").split(/\r?\n/);
  const events: DebugLogEvent[] = [];

  for (const line of lines) {
    if (!line.startsWith("- ")) continue;
    const raw = line.slice(2).trim();
    if (!raw) continue;

    const parts = raw.split(" | ").map((part) => part.trim());
    if (parts.length < 2) continue;
    const timestampISO = parts[0] ?? "";
    if (!timestampISO) continue;

    const meta = parseMetaTokens(parts.slice(1));
    const okRaw = (meta.ok ?? "").toLowerCase();
    const ok = okRaw === "true" ? true : okRaw === "false" ? false : undefined;
    const message = meta.message || parts.slice(1).join(" | ");

    events.push({
      timestampISO,
      source: "tool",
      chatJid: meta.chat,
      tool: meta.tool,
      ok,
      message,
      raw
    });
  }

  return events;
}

function parseDecisionLog(filePath: string): DebugLogEvent[] {
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, "utf-8").split(/\r?\n/);
  const events: DebugLogEvent[] = [];

  for (const line of lines) {
    if (!line.startsWith("- ")) continue;
    const raw = line.slice(2).trim();
    if (!raw) continue;

    const parts = raw.split(" | ").map((part) => part.trim());
    if (parts.length < 2) continue;
    const timestampISO = parts[0] ?? "";
    if (!timestampISO) continue;

    const meta = parseMetaTokens(parts.slice(1));
    const decision = meta.decision;
    const message = decision
      ? `decision=${decision}`
      : meta.skipped
      ? `skipped=${meta.skipped}`
      : parts.slice(1).join(" | ");

    events.push({
      timestampISO,
      source: "decision",
      chatJid: meta.chat,
      senderJid: meta.sender,
      decision,
      message,
      raw
    });
  }

  return events;
}

function parseMetaTokens(tokens: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const token of tokens) {
    const idx = token.indexOf("=");
    if (idx <= 0) continue;
    const key = token.slice(0, idx).trim();
    const value = token.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = value;
  }
  return out;
}
