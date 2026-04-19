import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { CHAT_DIR } from "./config";
import type { GeminiClient } from "./gemini";
import { readChatHistoryRaw } from "./storage";
import { sanitizeJid } from "./utils";

export type SummarizeGroupOptions = {
  chatJid: string;
  chatLabel?: string;
  hours?: number;
  maxMessages?: number;
  model: string;
};

export type SummaryResult = {
  chatJid: string;
  messageCount: number;
  summary: string;
  actionItems: string[];
  mentions: string[];
};

export type DigestOptions = {
  hours?: number;
  maxPerChat?: number;
  model: string;
  onlyChatJids?: string[];
};

export type DigestEntry = {
  chatJid: string;
  label: string;
  summary: string;
  actionItems: string[];
  messageCount: number;
};

export class Summarizer {
  constructor(private readonly gemini: GeminiClient) {}

  async summarizeChat(options: SummarizeGroupOptions): Promise<SummaryResult> {
    const hours = options.hours ?? 24;
    const maxMessages = options.maxMessages ?? 120;
    const entries = readChatHistoryRaw(options.chatJid);
    const since = Date.now() - hours * 60 * 60 * 1000;

    const windowed = entries
      .filter((entry) => {
        const ts = Date.parse(entry.timestampISO);
        return Number.isFinite(ts) ? ts >= since : true;
      })
      .slice(-maxMessages);

    if (windowed.length === 0) {
      return {
        chatJid: options.chatJid,
        messageCount: 0,
        summary: `No activity in the last ${hours}h.`,
        actionItems: [],
        mentions: []
      };
    }

    const transcript = windowed
      .map((entry) => {
        const speaker = entry.role === "outgoing" ? "me" : shortSpeaker(entry.senderJid);
        return `[${entry.timestampISO}] ${speaker}: ${entry.text}`;
      })
      .join("\n");

    const label = options.chatLabel ?? options.chatJid;
    const prompt = buildSummaryPrompt(label, hours, transcript);

    let rawResponse = "";
    try {
      rawResponse = await this.gemini.generate({
        model: options.model,
        parts: [{ text: prompt }],
        temperature: 0.2,
        maxOutputTokens: 600
      });
    } catch (error) {
      return {
        chatJid: options.chatJid,
        messageCount: windowed.length,
        summary: `Unable to summarize right now (${stringifyError(error)}).`,
        actionItems: [],
        mentions: []
      };
    }

    const parsed = parseSummaryResponse(rawResponse);
    return {
      chatJid: options.chatJid,
      messageCount: windowed.length,
      summary: parsed.summary || truncate(rawResponse, 600),
      actionItems: parsed.actionItems,
      mentions: parsed.mentions
    };
  }

  async buildDigest(
    options: DigestOptions,
    lookupLabel: (jid: string) => string
  ): Promise<DigestEntry[]> {
    const hours = options.hours ?? 24;
    const since = Date.now() - hours * 60 * 60 * 1000;

    const chatJids = options.onlyChatJids ?? listActiveChats(since);
    const entries: DigestEntry[] = [];

    for (const chatJid of chatJids) {
      const history = readChatHistoryRaw(chatJid);
      const recent = history.filter((entry) => {
        const ts = Date.parse(entry.timestampISO);
        return Number.isFinite(ts) ? ts >= since : false;
      });
      if (recent.length === 0) continue;

      const summary = await this.summarizeChat({
        chatJid,
        chatLabel: lookupLabel(chatJid),
        hours,
        maxMessages: options.maxPerChat ?? 80,
        model: options.model
      });

      if (summary.messageCount === 0) continue;

      entries.push({
        chatJid,
        label: lookupLabel(chatJid),
        summary: summary.summary,
        actionItems: summary.actionItems,
        messageCount: summary.messageCount
      });
    }

    entries.sort((a, b) => b.messageCount - a.messageCount);
    return entries;
  }
}

export function formatDigestReply(entries: DigestEntry[], hours: number): string {
  if (entries.length === 0) {
    return `No activity across tracked chats in the last ${hours}h.`;
  }
  const header = `Digest • last ${hours}h • ${entries.length} chat${entries.length === 1 ? "" : "s"}`;
  const blocks = entries.slice(0, 10).map((entry) => {
    const lines = [`*${entry.label}* (${entry.messageCount} msgs)`, entry.summary];
    if (entry.actionItems.length > 0) {
      lines.push("Actions:");
      for (const item of entry.actionItems.slice(0, 4)) {
        lines.push(`• ${item}`);
      }
    }
    return lines.join("\n");
  });
  return [header, "", blocks.join("\n\n")].join("\n");
}

function listActiveChats(sinceMs: number): string[] {
  if (!existsSync(CHAT_DIR)) return [];
  const result: Array<{ jid: string; lastTs: number }> = [];
  for (const file of readdirSync(CHAT_DIR)) {
    if (!file.endsWith(".md")) continue;
    const jid = file.replace(/\.md$/, "");
    try {
      const full = readFileSync(path.join(CHAT_DIR, file), "utf-8");
      const matches = full.match(/^- (20\d{2}-\d{2}-\d{2}T[^\s|]+)/gm) ?? [];
      const lastTs = matches.length > 0
        ? Date.parse(matches[matches.length - 1].slice(2).trim())
        : 0;
      if (Number.isFinite(lastTs) && lastTs >= sinceMs) {
        result.push({ jid, lastTs });
      }
    } catch {
      // skip
    }
  }
  result.sort((a, b) => b.lastTs - a.lastTs);
  return result.map((r) => r.jid);
}

function buildSummaryPrompt(label: string, hours: number, transcript: string): string {
  return [
    `You are summarizing a WhatsApp chat ("${label}") for the account owner.`,
    `Window: last ${hours} hours.`,
    "",
    "Return JSON with this exact shape — no prose outside it:",
    `{ "summary": "<3-5 sentence recap of what happened>",`,
    `  "actionItems": ["<what the owner may need to do or reply to>", ...],`,
    `  "mentions": ["<names/topics worth flagging>", ...] }`,
    "",
    "Be factual. Do not invent names. Keep it short. If nothing important happened, say so.",
    "",
    "Transcript:",
    transcript,
    "",
    "JSON:"
  ].join("\n");
}

type ParsedSummary = {
  summary: string;
  actionItems: string[];
  mentions: string[];
};

function parseSummaryResponse(raw: string): ParsedSummary {
  const empty: ParsedSummary = { summary: "", actionItems: [], mentions: [] };
  if (!raw.trim()) return empty;
  const jsonBlock = extractJsonBlock(raw);
  if (!jsonBlock) {
    return { summary: raw.trim().slice(0, 600), actionItems: [], mentions: [] };
  }
  try {
    const parsed = JSON.parse(jsonBlock) as Partial<ParsedSummary>;
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
      actionItems: Array.isArray(parsed.actionItems)
        ? parsed.actionItems.filter((x): x is string => typeof x === "string")
        : [],
      mentions: Array.isArray(parsed.mentions)
        ? parsed.mentions.filter((x): x is string => typeof x === "string")
        : []
    };
  } catch {
    return { summary: raw.trim().slice(0, 600), actionItems: [], mentions: [] };
  }
}

function extractJsonBlock(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return raw.slice(start, end + 1);
}

function shortSpeaker(jid: string): string {
  const user = jid.split("@")[0] ?? jid;
  if (user.length <= 14) return user;
  return `${user.slice(0, 6)}..${user.slice(-4)}`;
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 3)}...`;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function resolveChatLabelFactory(opts: {
  chatDir?: string;
}): (jid: string) => string {
  void opts;
  return (jid: string) => {
    // Caller will typically inject a better label via group roster; here we
    // fall back to a compact JID.
    const user = jid.split("@")[0] ?? jid;
    if (jid.endsWith("@g.us")) return `Group ${user.slice(-6)}`;
    return user;
  };
}

export function _exportedForTestOnly_sanitize(jid: string): string {
  return sanitizeJid(jid);
}
