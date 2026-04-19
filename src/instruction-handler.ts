import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PERSONA_DIR, saveConfig } from "./config";
import type { AppConfig } from "./types";
import { compactText } from "./utils";
import { ensurePersonaScaffold } from "./persona";

export type InstructionResult = {
  ok: boolean;
  message: string;
  applied: string[];
  configChanged: boolean;
};

export type InstructionContext = {
  config: AppConfig;
  saveConfigSnapshot: (next: AppConfig) => void;
};

const SOUL_PATH = path.join(PERSONA_DIR, "soul.md");
const COMM_RULES_PATH = path.join(PERSONA_DIR, "communication_rules.md");
const RECENT_MEMORY_PATH = path.join(PERSONA_DIR, "recent_memory.md");

export async function applyNaturalLanguageInstruction(
  input: string,
  ctx: InstructionContext
): Promise<InstructionResult> {
  const text = compactText(input);
  if (!text) {
    return { ok: false, message: "Empty instruction.", applied: [], configChanged: false };
  }

  ensurePersonaScaffold();

  const applied: string[] = [];
  let configChanged = false;
  const next: AppConfig = { ...ctx.config };

  const muteMatch = text.match(
    /\bmute\s+(?:group|chat|the\s+group|the\s+chat)\s+([^\s,]+)/i
  );
  if (muteMatch && muteMatch[1]) {
    const target = muteMatch[1].trim();
    if (!next.mutedGroupJids.includes(target)) {
      next.mutedGroupJids = [...next.mutedGroupJids, target];
      configChanged = true;
      applied.push(`Muted ${target}.`);
    } else {
      applied.push(`${target} was already muted.`);
    }
  }

  const unmuteMatch = text.match(
    /\b(?:unmute|allow|enable)\s+(?:group|chat|the\s+group)\s+([^\s,]+)/i
  );
  if (unmuteMatch && unmuteMatch[1]) {
    const target = unmuteMatch[1].trim();
    const before = next.mutedGroupJids.length;
    next.mutedGroupJids = next.mutedGroupJids.filter((jid) => jid !== target);
    if (next.mutedGroupJids.length !== before) {
      configChanged = true;
      applied.push(`Unmuted ${target}.`);
    }
  }

  if (/\bonly\s+reply\s+(?:on|when)\s+mention/i.test(text) || /\b(?:enable|turn\s+on)\s+mention[-\s]?only/i.test(text)) {
    if (!next.replyOnlyOnMention) {
      next.replyOnlyOnMention = true;
      configChanged = true;
      applied.push("Enabled mention-only mode for groups.");
    }
  }
  if (/\b(?:disable|turn\s+off)\s+mention[-\s]?only/i.test(text) || /\breply\s+everywhere\b/i.test(text)) {
    if (next.replyOnlyOnMention) {
      next.replyOnlyOnMention = false;
      configChanged = true;
      applied.push("Disabled mention-only mode.");
    }
  }

  const tempoMatch = text.match(
    /\b(?:reply|respond)\s+(?:more\s+)?(slowly|slower|faster|quickly)\b/i
  );
  if (tempoMatch) {
    const dir = tempoMatch[1]?.toLowerCase() ?? "";
    if (dir.startsWith("slow")) {
      next.minReplyDelayMs = Math.min(30_000, Math.max(3_000, next.minReplyDelayMs * 1.5));
      next.maxReplyDelayMs = Math.min(60_000, Math.max(next.minReplyDelayMs + 2_000, next.maxReplyDelayMs * 1.5));
      configChanged = true;
      applied.push(
        `Reply delay increased to ${Math.round(next.minReplyDelayMs / 1000)}-${Math.round(
          next.maxReplyDelayMs / 1000
        )}s.`
      );
    } else {
      next.minReplyDelayMs = Math.max(500, Math.floor(next.minReplyDelayMs / 1.5));
      next.maxReplyDelayMs = Math.max(
        next.minReplyDelayMs + 500,
        Math.floor(next.maxReplyDelayMs / 1.5)
      );
      configChanged = true;
      applied.push(
        `Reply delay decreased to ${Math.round(next.minReplyDelayMs / 1000)}-${Math.round(
          next.maxReplyDelayMs / 1000
        )}s.`
      );
    }
  }

  const limitMatch = text.match(/\b(?:daily|max)\s+(?:group\s+)?(?:messages?|replies?)\s+(?:limit\s+)?(?:to\s+)?(\d{1,4})\b/i);
  if (limitMatch && limitMatch[1]) {
    const n = Math.max(10, Math.min(2_000, Number(limitMatch[1])));
    if (n !== next.dailyMessageLimit) {
      next.dailyMessageLimit = n;
      configChanged = true;
      applied.push(`Daily group message limit set to ${n}.`);
    }
  }

  const personaPrefix = text.match(
    /^(?:add\s+to\s+|remember\s+(?:in\s+)?)(soul|communication(?:\s+rules)?|rules|recent(?:\s+memory)?)\s*[:\-]?\s*(.+)$/i
  );
  if (personaPrefix && personaPrefix[2]) {
    const target = personaPrefix[1]?.toLowerCase() ?? "";
    const payload = personaPrefix[2].trim();
    const file =
      target.startsWith("comm") || target.startsWith("rules")
        ? COMM_RULES_PATH
        : target.startsWith("recent")
        ? RECENT_MEMORY_PATH
        : SOUL_PATH;
    appendPersonaLine(file, payload);
    applied.push(`Appended to ${path.basename(file)}: "${truncate(payload, 80)}"`);
  }

  const tonePatterns: Array<{ pattern: RegExp; note: string }> = [
    { pattern: /\bbe\s+more\s+formal\b/i, note: "Tone: be more formal." },
    { pattern: /\bbe\s+more\s+casual\b/i, note: "Tone: be more casual." },
    { pattern: /\b(?:be\s+)?shorter\b/i, note: "Tone: keep replies short." },
    { pattern: /\b(?:be\s+)?(?:more\s+)?friendly\b/i, note: "Tone: be friendly." },
    { pattern: /\bdon'?t\s+use\s+emojis?\b/i, note: "Do not use emojis in replies." },
    { pattern: /\buse\s+emojis?\b/i, note: "Use emojis naturally in replies." },
    { pattern: /\bstop\s+(?:using|the)\s+exclamation/i, note: "Avoid exclamation marks." }
  ];

  for (const { pattern, note } of tonePatterns) {
    if (pattern.test(text)) {
      appendPersonaLine(COMM_RULES_PATH, note);
      applied.push(`Added to communication rules: "${note}"`);
    }
  }

  if (applied.length === 0) {
    if (/^add\s+to\s+soul[:\-]?/i.test(text) === false && /persona|soul|rules|remember/i.test(text)) {
      appendPersonaLine(RECENT_MEMORY_PATH, text);
      applied.push(`Saved to recent_memory.md: "${truncate(text, 80)}"`);
    }
  }

  if (configChanged) {
    try {
      saveConfig(next);
      ctx.saveConfigSnapshot(next);
    } catch (error) {
      return {
        ok: false,
        message: `Could not save config: ${stringifyError(error)}`,
        applied,
        configChanged
      };
    }
  }

  if (applied.length === 0) {
    return {
      ok: false,
      message:
        'I couldn\'t map that to a concrete change. Try: "mute group <jid>", "be more formal", "add to soul: I hate small talk", "daily limit 150", "reply more slowly".',
      applied,
      configChanged
    };
  }

  return {
    ok: true,
    message: applied.join(" "),
    applied,
    configChanged
  };
}

function appendPersonaLine(filePath: string, line: string): void {
  const clean = line.replace(/\s+/g, " ").trim();
  if (!clean) return;
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
  const timestamp = new Date().toISOString().slice(0, 10);
  const addition = `\n- ${timestamp} | ${clean}`;
  writeFileSync(filePath, existing.endsWith("\n") ? existing + addition.slice(1) : existing + addition, "utf-8");
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
