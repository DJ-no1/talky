import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { DATA_DIR } from "./config";
import type { AppConfig, IncomingMedia } from "./types";
import { sanitizeJid } from "./utils";

/**
 * Claude mediator bridge.
 *
 * Talky's message loop enqueues every allowed inbound message here so an external
 * Claude Code agent can act as the responder through Talky's live Baileys session:
 *   - data/claude/pending.jsonl  — events waiting for Claude (one JSON object per line)
 *   - data/claude/handled.jsonl  — acked events (audit trail)
 *   - data/claude/signal.json    — cheap poll target: { seq, pendingCount, lastEventAtISO }
 *   - data/media/                — incoming attachments persisted to disk
 *
 * Claude consumes the queue via the /api/claude/* control-server endpoints (or the
 * files directly) and replies via POST /api/claude/send. See CLAUDE.md.
 */

export const CLAUDE_BRIDGE_DIR = path.join(DATA_DIR, "claude");
export const CLAUDE_PENDING_PATH = path.join(CLAUDE_BRIDGE_DIR, "pending.jsonl");
export const CLAUDE_HANDLED_PATH = path.join(CLAUDE_BRIDGE_DIR, "handled.jsonl");
export const CLAUDE_SIGNAL_PATH = path.join(CLAUDE_BRIDGE_DIR, "signal.json");
export const MEDIA_INBOX_DIR = path.join(DATA_DIR, "media");

export type ClaudeBridgeMedia = {
  kind: IncomingMedia["kind"];
  mimeType: string;
  /** Absolute path of the saved attachment under data/media/. */
  path: string;
  fileName?: string;
  caption?: string;
};

export type ClaudeBridgeEvent = {
  id: string;
  timestampISO: string;
  chatJid: string;
  senderJid: string;
  /** Display name of the sender (push name / contact store), when known. */
  senderName?: string;
  /** Group subject or contact display name for the chat, when known. */
  chatName?: string;
  isGroup: boolean;
  mentionedMe: boolean;
  /** Transcribed text (or plain text). For voice notes this is the Gemini transcription. */
  text: string;
  /** True when text is a Gemini transcription of a voice note, not the original text message. */
  voiceTranscript?: boolean;
  media?: ClaudeBridgeMedia;
};

function ensureBridgeDirs(): void {
  for (const dir of [CLAUDE_BRIDGE_DIR, MEDIA_INBOX_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function readJsonlEvents(filePath: string): ClaudeBridgeEvent[] {
  if (!existsSync(filePath)) return [];
  const events: ClaudeBridgeEvent[] = [];
  for (const line of readFileSync(filePath, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ClaudeBridgeEvent;
      if (parsed && typeof parsed.id === "string" && typeof parsed.chatJid === "string") {
        events.push(parsed);
      }
    } catch {
      // skip corrupt line
    }
  }
  return events;
}

function bumpSignal(pendingCount: number, lastEventAtISO: string): void {
  let seq = 0;
  try {
    if (existsSync(CLAUDE_SIGNAL_PATH)) {
      const prior = JSON.parse(readFileSync(CLAUDE_SIGNAL_PATH, "utf-8")) as { seq?: number };
      seq = typeof prior.seq === "number" ? prior.seq : 0;
    }
  } catch {
    // start fresh on corrupt signal file
  }
  writeFileSync(
    CLAUDE_SIGNAL_PATH,
    JSON.stringify({ seq: seq + 1, pendingCount, lastEventAtISO }, null, 2),
    "utf-8"
  );
}

export function enqueueClaudeEvent(event: ClaudeBridgeEvent): void {
  ensureBridgeDirs();
  appendFileSync(CLAUDE_PENDING_PATH, `${JSON.stringify(event)}\n`, "utf-8");
  bumpSignal(listPendingClaudeEvents().length, event.timestampISO);
}

export function listPendingClaudeEvents(): ClaudeBridgeEvent[] {
  return readJsonlEvents(CLAUDE_PENDING_PATH);
}

/** Remove acked events from pending.jsonl and archive them to handled.jsonl. Returns how many were acked. */
export function ackClaudeEvents(ids: string[]): number {
  ensureBridgeDirs();
  const ackSet = new Set(ids.map((id) => id.trim()).filter(Boolean));
  if (ackSet.size === 0) return 0;
  const pending = listPendingClaudeEvents();
  const remaining = pending.filter((event) => !ackSet.has(event.id));
  const acked = pending.filter((event) => ackSet.has(event.id));
  if (acked.length === 0) return 0;
  writeFileSync(
    CLAUDE_PENDING_PATH,
    remaining.map((event) => JSON.stringify(event)).join("\n") + (remaining.length > 0 ? "\n" : ""),
    "utf-8"
  );
  const handledAtISO = new Date().toISOString();
  for (const event of acked) {
    appendFileSync(
      CLAUDE_HANDLED_PATH,
      `${JSON.stringify({ ...event, handledAtISO })}\n`,
      "utf-8"
    );
  }
  bumpSignal(remaining.length, handledAtISO);
  return acked.length;
}

const MIME_EXTENSION_MAP: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/3gpp": ".3gp",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/wav": ".wav",
  "application/pdf": ".pdf"
};

function extensionForMedia(media: IncomingMedia): string {
  if (media.fileName) {
    const ext = path.extname(media.fileName);
    if (ext) return ext.toLowerCase();
  }
  const base = media.mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return MIME_EXTENSION_MAP[base] ?? ".bin";
}

/** Persist an incoming attachment to data/media/ and return its absolute path. */
export function saveIncomingMediaToDisk(
  media: IncomingMedia,
  chatJid: string,
  messageId?: string
): string {
  ensureBridgeDirs();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const idPart = (messageId ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "msg";
  const fileName = `${stamp}_${sanitizeJid(chatJid)}_${idPart}${extensionForMedia(media)}`;
  const absolutePath = path.join(MEDIA_INBOX_DIR, fileName);
  writeFileSync(absolutePath, media.bytes);
  return absolutePath;
}

let lastTriggerSpawnAtMs = 0;

/**
 * Spawn the configured trigger command (detached, fire-and-forget) so an external
 * Claude agent wakes up. Debounced by claudeTriggerCooldownSeconds — pending events
 * accumulate in the queue either way, so a single wake-up drains them all.
 */
export function maybeSpawnClaudeTrigger(
  config: AppConfig,
  onWarn?: (message: string) => void
): boolean {
  const command = config.claudeTriggerCommand.trim();
  if (!command) return false;
  const now = Date.now();
  if (now - lastTriggerSpawnAtMs < config.claudeTriggerCooldownSeconds * 1000) return false;
  lastTriggerSpawnAtMs = now;
  try {
    const child = spawn(command, {
      shell: true,
      detached: true,
      stdio: "ignore",
      cwd: process.cwd()
    });
    child.unref();
    return true;
  } catch (error) {
    onWarn?.(error instanceof Error ? error.message : String(error));
    return false;
  }
}
