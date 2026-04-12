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
