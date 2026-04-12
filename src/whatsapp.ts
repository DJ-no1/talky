import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  useMultiFileAuthState
} from "baileys";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { recordUnauthorized } from "./unauthorized";
import { AUTH_DIR } from "./config";
import type {
  AppConfig,
  AppEnv,
  GeminiToolCall,
  IncomingContext,
  MemoryItem,
  MessageRecord
} from "./types";
import {
  appendChatHistory,
  appendDecisionLog,
  readRecentChatHistory,
  readRecentOutgoingMessages,
  readRecentSenderMessages
} from "./storage";
import { MemoryService } from "./memory";
import {
  GeminiClient,
  type GeminiConversationContent,
  type GeminiTextPart
} from "./gemini";
import { decideReply } from "./decision";
import { buildReplySystemPrompt } from "./prompts";
import {
  ensureContactProfile,
  ensureGroupProfile,
  ensurePersonaScaffold,
  loadPersonaContext
} from "./persona";
import { buildToolDeclarations, executeToolCall } from "./tool-executor";
import { compactText, randomBetween, sleep } from "./utils";

type BaileysMessage = any;
type BaileysSocket = any;

const KNOWN_LIBSIGNAL_CONSOLE_NOISE: RegExp[] = [
  /^closing stale open session for new outgoing prekey bundle\b/i,
  /^closing open session for new outgoing prekey bundle\b/i,
  /^closing open session in favor of incoming prekey bundle\b/i,
  /^closing session\b/i,
  /^removing old closed session\b/i
];

let consoleNoiseFilterInstalled = false;

function normalizeConsoleArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  if (arg === null || arg === undefined) return "";
  if (typeof arg === "object") {
    return (arg as { constructor?: { name?: string } }).constructor?.name ?? "";
  }
  return String(arg);
}

function shouldSuppressKnownLibsignalConsoleNoise(args: unknown[]): boolean {
  const normalized = args
    .map((arg) => normalizeConsoleArg(arg))
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 0);
  if (normalized.length === 0) return false;

  for (const part of normalized) {
    if (KNOWN_LIBSIGNAL_CONSOLE_NOISE.some((pattern) => pattern.test(part))) {
      return true;
    }
  }

  const combined = normalized.join(" ").replace(/\s+/g, " ").trim();
  return KNOWN_LIBSIGNAL_CONSOLE_NOISE.some((pattern) => pattern.test(combined));
}

function installKnownConsoleNoiseFilter(): void {
  if (consoleNoiseFilterInstalled) return;
  consoleNoiseFilterInstalled = true;

  const wrap = (original: (...args: unknown[]) => void) => {
    return (...args: unknown[]) => {
      if (shouldSuppressKnownLibsignalConsoleNoise(args)) return;
      original(...args);
    };
  };

  console.log = wrap(console.log.bind(console));
  console.info = wrap(console.info.bind(console));
  console.debug = wrap(console.debug.bind(console));
  console.trace = wrap(console.trace.bind(console));
  console.warn = wrap(console.warn.bind(console));
  console.error = wrap(console.error.bind(console));
}

installKnownConsoleNoiseFilter();

const ANSI_RESET = "\u001b[0m";
const ANSI_DIM = "\u001b[90m";
const ANSI_AI = "\u001b[36m";
const ANSI_ME = "\u001b[32m";
const ACTOR_COLORS = [
  "\u001b[38;5;39m",
  "\u001b[38;5;45m",
  "\u001b[38;5;81m",
  "\u001b[38;5;111m",
  "\u001b[38;5;149m",
  "\u001b[38;5;208m",
  "\u001b[38;5;214m",
  "\u001b[38;5;177m"
];

function hashText(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function colorForActor(actorId: string): string {
  return ACTOR_COLORS[hashText(actorId) % ACTOR_COLORS.length] ?? "";
}

function shortActorLabel(actorId: string): string {
  const normalized = jidNormalizedUser(actorId);
  const user = normalized.split("@")[0] ?? normalized;
  if (user.length <= 14) return user;
  return `${user.slice(0, 6)}...${user.slice(-4)}`;
}

function previewText(value: string, maxLength = 120): string {
  const compact = compactText(value);
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 3))}...`;
}

function shouldIgnoreIncomingJid(jid?: string | null): boolean {
  if (!jid) return false;
  return (
    jid === "status@broadcast" ||
    jid.endsWith("@broadcast") ||
    jid.endsWith("@newsletter")
  );
}

export class WhatsAppAgent {
  private readonly logger: ReturnType<typeof pino>;
  private verboseRuntimeLogs: boolean;
  private readonly gemini: GeminiClient;
  private readonly memory: MemoryService;
  private sock: BaileysSocket | null = null;
  private ownJid = "";
  private readonly chatQueues = new Map<string, Promise<void>>();
  private readonly recentOutgoingByChat = new Map<string, string[]>();
  private readonly recentIncomingStickersByChat = new Map<
    string,
    Array<{ bytes: Buffer; mimeType: string; at: number }>
  >();
  private groupsCache: { at: number; rows: Array<{ jid: string; name: string }> } = {
    at: 0,
    rows: []
  };
  private sentCount = 0;
  private sentDay = new Date().toISOString().slice(0, 10);
  private readonly colorEnabled = Boolean(process.stdout.isTTY);
  private proactiveStartupTriggered = false;
  private readonly groupPermissionCache = new Map<
    string,
    { ts: number; allowed: boolean; reason: string }
  >();

  constructor(
    private config: AppConfig,
    private readonly env: AppEnv
  ) {
    this.verboseRuntimeLogs = config.runtimeLogMode === "verbose";
    this.logger = pino({ level: this.verboseRuntimeLogs ? "info" : "warn" });
    ensurePersonaScaffold();
    this.gemini = new GeminiClient(env.geminiApiKey);
    this.memory = new MemoryService(env.mem0ApiKey);
  }

  async start(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    this.sock = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      fireInitQueries: false,
      syncFullHistory: false,
      shouldIgnoreJid: shouldIgnoreIncomingJid,
      // For this bot we do not need historical backfill; skipping it avoids
      // startup decrypt storms from stale history/session state.
      shouldSyncHistoryMessage: () => false,
      logger: this.logger.child({ module: "baileys" })
    });

    this.sock.ev.on("creds.update", saveCreds);
    this.sock.ev.on("connection.update", async (update: any) => {
      const { connection, qr, lastDisconnect } = update;
      if (qr) {
        console.log("\nScan this QR in WhatsApp > Linked devices:\n");
        qrcode.generate(qr, { small: true });
      }
      if (connection === "open") {
        this.ownJid = jidNormalizedUser(this.sock?.user?.id ?? "");
        console.log(`Connected as ${this.ownJid}`);
        if (!this.proactiveStartupTriggered) {
          this.proactiveStartupTriggered = true;
          await this.maybeSendStartupProactiveMessages();
        }
      }
      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = code === DisconnectReason.loggedOut || code === 401;
        const isReplaced = code === DisconnectReason.connectionReplaced || code === 440;
        const isRestart = code === DisconnectReason.restartRequired || code === 515;
        const isBadSession = code === DisconnectReason.badSession || code === 500;
        this.logger.warn({ code }, "connection closed");
        if (isLoggedOut) {
          console.log("Logged out from WhatsApp. Delete wa_auth and login again.");
          return;
        }
        if (isReplaced) {
          console.log("Connection replaced by another session/process. Stop other Talky runs.");
          return;
        }
        if (isBadSession) {
          console.log("Bad session (500). State is corrupted. Please run `bun run session:repair` or `bun run relink`.");
          return;
        }
        if (isRestart) {
          await sleep(1200);
          await this.start();
          return;
        }
        await sleep(2500);
        await this.start();
      }
    });

    this.sock.ev.on("messages.upsert", ({ messages }: any) => {
      for (const message of messages as BaileysMessage[]) {
        this.enqueue(message);
      }
    });
  }

  private enqueue(message: BaileysMessage): void {
    // Per-chat queues: each chatJid has its own promise chain so chats run
    // in parallel without stepping on each other. Messages within a single
    // chat stay strictly ordered.
    const chatJid = (message?.key?.remoteJid as string | undefined) ?? "__unknown__";
    const previous = this.chatQueues.get(chatJid) ?? Promise.resolve();
    const next = previous
      .then(async () => this.handleMessage(message))
      .catch((error) => {
        this.logger.error({ error, chatJid }, "failed to process message");
      })
      .finally(() => {
        // Clean up the map entry if this was the tail of the chain, so the
        // map doesn't grow unbounded over long sessions.
        if (this.chatQueues.get(chatJid) === next) {
          this.chatQueues.delete(chatJid);
        }
      });
    this.chatQueues.set(chatJid, next);
  }

  private evaluateChatPolicy(chatJid: string, isGroup: boolean): {
    allowed: boolean;
    reason: string;
  } {
    if (isGroup) {
      if (this.config.mutedGroupJids.includes(chatJid)) {
        return { allowed: false, reason: "group is muted" };
      }
      if (this.config.allowedGroupJids.length === 0) {
        return { allowed: true, reason: "group allowed (no allowlist configured)" };
      }
      const allowed = this.config.allowedGroupJids.includes(chatJid);
      return {
        allowed,
        reason: allowed
          ? "group matched allowlist"
          : "group not in allowedGroupJids"
      };
    }
    if (this.config.directChatMode === "none") {
      return { allowed: false, reason: "directChatMode=none" };
    }
    if (this.config.directChatMode === "all") {
      return { allowed: true, reason: "directChatMode=all" };
    }
    const allowed = isDirectJidAllowed(chatJid, this.config.allowedDirectJids);
    return {
      allowed,
      reason: allowed
        ? "direct matched allowlist"
        : `direct not in allowlist (mode=allowlist, allowlistSize=${this.config.allowedDirectJids.length})`
    };
  }

  private canSendMoreToday(): boolean {
    const today = new Date().toISOString().slice(0, 10);
    if (this.sentDay !== today) {
      this.sentDay = today;
      this.sentCount = 0;
    }
    return this.sentCount < this.config.dailyMessageLimit;
  }

  public updateConfig(newConfig: typeof this.config): void {
    this.config = newConfig;
    this.verboseRuntimeLogs = newConfig.runtimeLogMode === "verbose";
  }

  public getStore(): any {
    return {
      chats: this.sock?.store?.chats,
      contacts: this.sock?.store?.contacts,
    };
  }

  public async getGroups(forceRefresh = false): Promise<{jid: string, name: string}[]> {
    if (!this.sock) return this.groupsCache.rows;

    const now = Date.now();
    if (!forceRefresh && this.groupsCache.rows.length > 0 && now - this.groupsCache.at < 60_000) {
      return this.groupsCache.rows;
    }

    try {
      const rows = await fetchJoinedGroups(this.sock);
      this.groupsCache = { at: now, rows };
      return rows;
    } catch (error) {
      this.logger.warn({ error }, "failed to fetch groups; returning cached groups");
      return this.groupsCache.rows;
    }
  }
  
  public async relinkSession(): Promise<void> {
    if (this.sock) {
      this.sock.logout();
    }
  }

  public async repairSession(): Promise<void> {
    if (this.sock) {
      this.sock.end(undefined);
    }
  }

  private resolveContactDisplayName(jid: string, pushName?: string): string | undefined {
    const blockedValues = new Set(this.possibleContactKeys(jid).map((value) => value.toLowerCase()));
    const candidates: string[] = [];

    const maybePushName = this.normalizeContactName(pushName, blockedValues);
    if (maybePushName) {
      candidates.push(maybePushName);
    }

    const storeContacts = this.sock?.store?.contacts as Record<string, unknown> | undefined;
    if (storeContacts) {
      for (const key of this.possibleContactKeys(jid)) {
        const entry = storeContacts[key] as
          | {
              name?: string;
              notify?: string;
              verifiedName?: string;
              short?: string;
              vname?: string;
              subject?: string;
            }
          | undefined;
        if (!entry) continue;
        for (const value of [
          entry.name,
          entry.notify,
          entry.verifiedName,
          entry.short,
          entry.vname,
          entry.subject
        ]) {
          const normalized = this.normalizeContactName(value, blockedValues);
          if (normalized) candidates.push(normalized);
        }
      }
    }

    return candidates[0];
  }

  private possibleContactKeys(jid: string): string[] {
    const keys = new Set<string>();
    const normalized = jidNormalizedUser(jid);
    if (jid) keys.add(jid);
    if (normalized) keys.add(normalized);
    const user = (normalized || jid).split("@")[0] ?? "";
    if (user) {
      keys.add(`${user}@s.whatsapp.net`);
      keys.add(`${user}@lid`);
    }
    return [...keys];
  }

  private normalizeContactName(
    value: string | undefined,
    blockedValues: Set<string>
  ): string | undefined {
    const normalized = compactText(value ?? "");
    if (!normalized) return undefined;
    const lowered = normalized.toLowerCase();
    if (lowered === "unknown" || lowered === "null" || lowered === "undefined") {
      return undefined;
    }
    if (blockedValues.has(lowered)) return undefined;
    return normalized;
  }

  private async handleMessage(raw: BaileysMessage): Promise<void> {
    if (!this.sock) return;
    if (!raw?.message) return;
    if (raw?.key?.fromMe) {
      this.logger.info(
        { msgId: raw?.key?.id, chatJid: raw?.key?.remoteJid },
        "skipping self-sent message (fromMe)"
      );
      return;
    }
    const remoteJid = raw?.key?.remoteJid as string | undefined;
    if (!remoteJid) return;
    if (remoteJid === "status@broadcast") return;
    if (remoteJid.endsWith("@newsletter") || remoteJid.endsWith("@broadcast")) {
      this.logger.info({ msgId: raw?.key?.id, chatJid: remoteJid }, "skipping newsletter/broadcast");
      return;
    }

    const context = await this.parseIncoming(raw);
    if (!context) return;
    this.rememberIncomingSticker(context.chatJid, context.media);
    const incomingText = compactText(context.text || context.media?.caption || "");
    if (incomingText && this.isRecentOutgoing(context.chatJid, incomingText)) {
      this.logger.warn(
        { msgId: raw?.key?.id, chatJid: context.chatJid, textPreview: incomingText.slice(0, 80) },
        "skipping echo of recently-sent outgoing message (loop guard)"
      );
      return;
    }
    if (context.isGroup && this.isSelfSender(raw, context.senderJid)) {
      this.logger.info(
        { msgId: raw?.key?.id, chatJid: context.chatJid, senderJid: context.senderJid },
        "skipping own group message (self sender id)"
      );
      return;
    }
    if (!context.isGroup && this.isSelfSender(raw, context.senderJid)) {
      this.logger.info(
        { msgId: raw?.key?.id, chatJid: context.chatJid, senderJid: context.senderJid },
        "skipping own direct message (self sender id)"
      );
      return;
    }
    this.logger.info(
      {
        msgId: raw?.key?.id,
        chatJid: context.chatJid,
        senderJid: context.senderJid,
        isGroup: context.isGroup,
        hasMedia: Boolean(context.media),
        textPreview: (context.text || context.media?.caption || "[media]").slice(0, 120)
      },
      "inbound message received"
    );
    const policy = this.evaluateChatPolicy(context.chatJid, context.isGroup);
    if (!policy.allowed) {
      if (policy.reason !== "self message") {
        recordUnauthorized(context.chatJid, context.isGroup, policy.reason, raw.pushName);
      }
      this.logger.info(
        {
          msgId: raw?.key?.id,
          chatJid: context.chatJid,
          senderJid: context.senderJid,
          reason: policy.reason
        },
        "skipping message: chat not allowed by config"
      );
      return;
    }
    this.logger.info(
      { msgId: raw?.key?.id, chatJid: context.chatJid, senderJid: context.senderJid, reason: policy.reason },
      "chat allowed by policy"
    );
    this.logMinimalFlow(
      "USER",
      `${context.chatJid} | msg: ${previewText(context.text || context.media?.caption || "[media]")}`,
      context.senderJid
    );

    this.writeHistory(context, "incoming");
    const incomingPushName = (raw as { pushName?: string } | undefined)?.pushName;
    if (context.isGroup) {
      ensureGroupProfile(context.chatJid);
      ensureContactProfile(
        context.senderJid,
        this.resolveContactDisplayName(context.senderJid, incomingPushName)
      );
    } else {
      ensureContactProfile(
        context.chatJid,
        this.resolveContactDisplayName(context.chatJid, incomingPushName)
      );
    }

    const recentHistory = readRecentChatHistory(context.chatJid, this.config.historyWindow);
    const recentSenderMessages = readRecentSenderMessages(
      context.chatJid,
      context.senderJid,
      this.config.senderHistoryWindow
    );
    const memoryQuery = context.text || context.media?.caption || "general";
    const memories = await this.memory.retrieve(
      context.senderJid,
      memoryQuery,
      this.config.memoryTopK
    );
    this.aiStage(
      "THINK",
      `processing ${context.chatJid} (${context.senderJid}) and scoring reply`
    );
    this.logMinimalFlow("AI", `${context.chatJid} | thinking...`, context.senderJid);
    this.logger.info(
      {
        msgId: raw?.key?.id,
        chatJid: context.chatJid,
        senderJid: context.senderJid,
        historyCount: recentHistory.length,
        senderHistoryCount: recentSenderMessages.length,
        memoryCount: memories.length
      },
      "tracking inbound context"
    );

    const decision = context.isGroup
      ? this.config.alwaysReplyInAllowedGroups
        ? "YES"
        : await decideReply({
            gemini: this.gemini,
            config: this.config,
            botName: this.config.botName,
            isGroup: context.isGroup,
            mentionedMe: context.mentionedMe,
            messageText: context.text || context.media?.caption || "[media]",
            recentHistory,
            memories
          })
      : "YES";
    this.logger.info(
      {
        msgId: raw?.key?.id,
        chatJid: context.chatJid,
        senderJid: context.senderJid,
        decision
      },
      "reply decision computed"
    );
    this.aiStage("DECISION", `${decision} for ${context.chatJid}`);
    if (!context.isGroup) {
      this.aiStage("DECISION", `1:1 chat forced YES for ${context.chatJid}`);
    } else if (this.config.alwaysReplyInAllowedGroups) {
      this.aiStage("DECISION", `group forced YES (alwaysReplyInAllowedGroups=true)`);
    }

    appendDecisionLog(
      `${new Date().toISOString()} | chat=${context.chatJid} | sender=${context.senderJid} | decision=${decision}`
    );

    if (decision !== "YES") {
      this.aiStage("SKIP", `${decision} -> no reply for ${context.chatJid}`);
      this.logger.info(
        { msgId: raw?.key?.id, chatJid: context.chatJid, senderJid: context.senderJid, decision },
        "no outgoing reply for this inbound message"
      );
      return;
    }
    if (context.isGroup && !this.canSendMoreToday()) {
      this.aiStage("SKIP", `daily limit reached for ${context.chatJid}`);
      this.logger.info(
        { msgId: raw?.key?.id, chatJid: context.chatJid },
        "skipping reply: daily limit reached"
      );
      appendDecisionLog(`${new Date().toISOString()} | skipped: daily limit reached`);
      return;
    }
    if (context.isGroup && this.config.askBeforeReply && !context.mentionedMe) {
      this.aiStage("SKIP", `askBeforeReply enabled for ${context.chatJid}`);
      this.logger.info(
        { msgId: raw?.key?.id, chatJid: context.chatJid },
        "skipping reply: askBeforeReply mode"
      );
      appendDecisionLog(`${new Date().toISOString()} | defer: askBeforeReply mode`);
      return;
    }

    if (context.isGroup) {
      const permission = await this.checkGroupSendPermission(context.chatJid);
      if (!permission.allowed) {
        this.aiStage("SKIP", `cannot send to group: ${permission.reason}`);
        this.logger.warn(
          {
            msgId: raw?.key?.id,
            chatJid: context.chatJid,
            reason: permission.reason
          },
          "skipping reply: no group send permission"
        );
        appendDecisionLog(
          `${new Date().toISOString()} | skipped: no group send permission | chat=${context.chatJid} | reason=${permission.reason}`
        );
        return;
      }
    }

    const replyResult = await this.generateReply(context, memories, recentHistory);
    const reply = replyResult.replyText;

    if (!reply && replyResult.sentViaTools > 0) {
      this.aiStage(
        "SENT",
        `tool actions sent ${replyResult.sentViaTools} message(s) to ${context.chatJid}`
      );
      this.sentCount += 1;
      return;
    }

    if (!reply && context.isGroup) {
      this.aiStage("SKIP", `model returned NO_REPLY for ${context.chatJid}`);
      this.logger.info(
        { msgId: raw?.key?.id, chatJid: context.chatJid, senderJid: context.senderJid },
        "model returned NO_REPLY/empty output"
      );
      return;
    }
    const finalReply = reply || this.directFallbackReply(context.text);
    if (!reply) {
      this.aiStage("REPLY", `using fallback direct reply for ${context.chatJid}`);
    }
    this.logger.info(
      {
        msgId: raw?.key?.id,
        chatJid: context.chatJid,
        senderJid: context.senderJid,
        replyPreview: finalReply.slice(0, 120)
      },
      "reply generated, sending now"
    );
    this.logMinimalFlow("AI", `${context.chatJid} | draft: ${previewText(finalReply)}`, context.senderJid);
    const messageChunks = splitReplyOutputToMessages(finalReply);
    this.aiStage(
      "REPLY",
      `sending ${messageChunks.length} msg(s) to ${context.chatJid}: ${messageChunks[0]?.slice(0, 80) ?? ""}`
    );

    await this.sendReplies(context.chatJid, messageChunks, raw, context.senderJid);
    this.sentCount += 1;

    const memoryCandidate = inferMemoryFact(context.text);
    if (memoryCandidate) {
      await this.memory.remember(context.senderJid, memoryCandidate, "chat_auto");
    }
  }

  private async sendReplies(
    chatJid: string,
    texts: string[],
    quoted: BaileysMessage,
    senderJid: string
  ): Promise<void> {
    if (!this.sock) return;
    if (texts.length === 0) return;

    const delay = randomBetween(this.config.minReplyDelayMs, this.config.maxReplyDelayMs);
    await this.sock.sendPresenceUpdate("composing", chatJid);
    await sleep(delay);
    await this.sock.sendPresenceUpdate("paused", chatJid);

    for (let index = 0; index < texts.length; index += 1) {
      const text = texts[index] ?? "";
      if (!text.trim()) continue;
      if (index > 0) {
        await sleep(randomBetween(550, 1300));
      }
      await this.sendChunkWithRetry({
        chatJid,
        text,
        quoted: index === 0 && !chatJid.endsWith("@g.us") ? quoted : undefined
      });
      this.logger.info(
        {
          chatJid,
          quotedMsgId: quoted?.key?.id,
          part: index + 1,
          totalParts: texts.length,
          textPreview: text.slice(0, 120)
        },
        "reply sent"
      );
      this.logMinimalFlow("ME", `${chatJid} | sent: ${previewText(text)}`, senderJid);
      this.rememberOutgoing(chatJid, text);
      const out: MessageRecord = {
        chatJid,
        senderJid: this.ownJid || "me",
        timestampISO: new Date().toISOString(),
        role: "outgoing",
        text
      };
      appendChatHistory(out);
    }
    this.aiStage("SENT", `sent ${texts.length} msg(s) to ${chatJid}`);
  }

  private async sendChunkWithRetry(args: {
    chatJid: string;
    text: string;
    quoted?: BaileysMessage;
  }): Promise<void> {
    if (!this.sock) return;
    const { chatJid, text, quoted } = args;

    const attempts: Array<{ quoted?: BaileysMessage }> = quoted
      ? [{ quoted }, {}, {}]
      : [{}, {}, {}];
    let lastError: unknown = undefined;
    const isGroup = chatJid.endsWith("@g.us");

    // Pre-warm group sessions before the first attempt — clears stale
    // sender-key-memory and refreshes device sessions so the first send has
    // a clean slate. Without this, cached "already delivered" flags cause
    // encrypt() to throw "No sessions" on first attempt.
    if (isGroup) {
      await this.warmSessionsForChat(chatJid);
    }

    for (let i = 0; i < attempts.length; i += 1) {
      const attempt = attempts[i] ?? {};
      try {
        this.logger.info(
          {
            chatJid,
            attempt: i + 1,
            usingQuote: Boolean(attempt.quoted),
            textPreview: text.slice(0, 80)
          },
          "sending message chunk"
        );
        if (attempt.quoted) {
          await this.sock.sendMessage(
            chatJid,
            { text },
            { quoted: attempt.quoted, useCachedGroupMetadata: false }
          );
        } else {
          await this.sock.sendMessage(chatJid, { text }, { useCachedGroupMetadata: false });
        }
        return;
      } catch (error) {
        lastError = error;
        const errorName = (error as { name?: string } | undefined)?.name;
        const errData = (error as { data?: unknown } | undefined)?.data;
        const errStatus = (error as { output?: { statusCode?: number } } | undefined)?.output
          ?.statusCode;
        const is406 =
          errData === 406 ||
          String((error as { message?: string } | undefined)?.message ?? "").includes(
            "not-acceptable"
          );
        if (errorName === "SessionError" || (isGroup && is406)) {
          await this.warmSessionsForChat(chatJid);
        }
        const willRetry = i < attempts.length - 1;
        this.logger.warn(
          {
            chatJid,
            willRetry,
            attempt: i + 1,
            errorName,
            errorData: errData,
            errorStatusCode: errStatus,
            errorMessage: (error as { message?: string } | undefined)?.message
          },
          "send chunk failed"
        );
        if (!willRetry) break;
        await sleep(randomBetween(700, 1400));
      }
    }

    throw lastError instanceof Error ? lastError : new Error("failed to send message chunk");
  }

  private async warmSessionsForChat(chatJid: string): Promise<void> {
    if (!this.sock) return;
    try {
      const sock = this.sock as {
        assertSessions?: (jids: string[], force: boolean) => Promise<unknown>;
        getUSyncDevices?: (
          jids: string[],
          useCache: boolean,
          ignoreZeroDevices: boolean
        ) => Promise<Array<{ user: string; device?: number }>>;
        groupMetadata?: (jid: string) => Promise<any>;
        authState?: { keys?: { set?: (data: Record<string, any>) => Promise<void> | void } };
      };
      if (typeof sock.assertSessions !== "function") return;

      if (chatJid.endsWith("@g.us")) {
        const meta = await sock.groupMetadata?.(chatJid);
        const participantJids: string[] = (meta?.participants ?? [])
          .map((p: { id?: string }) => p?.id)
          .filter((jid: string | undefined): jid is string => Boolean(jid))
          .filter((jid: string) => !this.isSelfSenderJid(jid));

        // Clear stale sender-key-memory so Baileys re-sends sender key distribution
        // to every device on the next sendMessage (otherwise encrypt() throws
        // "No sessions" when a cached entry says "already sent" but the signal
        // session underneath is actually missing).
        try {
          await sock.authState?.keys?.set?.({ "sender-key-memory": { [chatJid]: {} } });
        } catch (clearError) {
          this.logger.warn({ chatJid, error: clearError }, "failed to clear sender-key-memory");
        }

        // Warm device-level sessions via USync — user-level JIDs aren't what
        // Baileys actually encrypts against.
        const isLidGroup = participantJids.some((jid) => jid.endsWith("@lid"));
        let deviceJids: string[] = [];
        if (typeof sock.getUSyncDevices === "function" && participantJids.length > 0) {
          try {
            const devices = await sock.getUSyncDevices(participantJids, false, false);
            deviceJids = devices.map(({ user, device }) => {
              const server = isLidGroup ? "lid" : "s.whatsapp.net";
              return device ? `${user}:${device}@${server}` : `${user}@${server}`;
            });
          } catch (usyncError) {
            this.logger.warn({ chatJid, error: usyncError }, "USync device fetch failed, falling back to participant JIDs");
          }
        }
        const jidsToWarm = deviceJids.length > 0 ? deviceJids : participantJids;
        if (jidsToWarm.length === 0) return;
        await sock.assertSessions(jidsToWarm, true);
        return;
      }
      const directJid = jidNormalizedUser(chatJid);
      if (!directJid) return;
      await sock.assertSessions([directJid], true);
    } catch (error) {
      this.logger.warn({ chatJid, error }, "session warmup failed");
    }
  }

  private async checkGroupSendPermission(
    chatJid: string,
    forceRefresh = false
  ): Promise<{ allowed: boolean; reason: string }> {
    if (!this.sock) return { allowed: false, reason: "socket not ready" };
    const now = Date.now();
    const cached = this.groupPermissionCache.get(chatJid);
    if (!forceRefresh && cached && now - cached.ts < 60_000) {
      return { allowed: cached.allowed, reason: cached.reason };
    }

    try {
      const metadata = await this.sock.groupMetadata(chatJid);
      const announce = Boolean((metadata as { announce?: boolean } | undefined)?.announce);
      const participants = ((metadata as { participants?: Array<{ id?: string; admin?: string }> })
        ?.participants ?? []) as Array<{ id?: string; admin?: string }>;
      const own = participants.find((p) => p?.id && this.isSelfSenderJid(p.id));
      const isAdmin = own?.admin === "admin" || own?.admin === "superadmin";
      const allowed = !announce || isAdmin;
      const reason = allowed
        ? announce
          ? "group is announce-only but account is admin"
          : "group allows all members to send"
        : "group is announce-only and account is not admin";

      this.groupPermissionCache.set(chatJid, { ts: now, allowed, reason });
      this.logger.info(
        {
          chatJid,
          announce,
          ownParticipant: own?.id ?? null,
          ownAdminRole: own?.admin ?? null,
          participantCount: participants.length,
          allowed,
          reason
        },
        "group send permission check"
      );
      return { allowed, reason };
    } catch (error) {
      const reason = `failed to read group metadata: ${
        (error as { message?: string } | undefined)?.message ?? "unknown"
      }`;
      this.logger.warn({ chatJid, error }, "group send permission check failed");
      return { allowed: true, reason };
    }
  }

  private async generateReply(
    context: IncomingContext,
    memories: MemoryItem[],
    recentHistory: string[]
  ): Promise<{ replyText: string; sentViaTools: number }> {
    const recentSenderMessages = readRecentSenderMessages(
      context.chatJid,
      context.senderJid,
      this.config.senderHistoryWindow
    );
    const ownRecentMessages = readRecentOutgoingMessages(
      context.chatJid,
      this.config.selfHistoryWindow
    );
    const persona = loadPersonaContext({
      chatJid: context.chatJid,
      senderJid: context.senderJid,
      isGroup: context.isGroup
    });

    const system = buildReplySystemPrompt({
      botName: this.config.botName,
      memories,
      recentHistory,
      recentSenderMessages,
      ownRecentMessages,
      persona,
      isGroup: context.isGroup
    });

    const stickerModeInstruction =
      this.config.stickerReplyMode === "always-sticker"
        ? "If possible, answer by sending a sticker via send_sticker instead of text."
        : this.config.stickerReplyMode === "explicit-only"
        ? "Use send_sticker only when user explicitly asks for a sticker/reaction."
        : "Decide naturally between text and send_sticker based on context.";

    const toolInstruction = this.config.toolCallingEnabled
      ? [
          "You may use tools when useful:",
          "- list_local_files: inspect allowed local folders.",
          "- read_local_file: read an allowed file within size limits.",
          "- share_local_file: send local file(s) to chat; folder path can send multiple images/files.",
          "- send_sticker: send a sticker from recent incoming or local sticker pack.",
          "When a tool is needed, execute it first and do not pretend it already happened.",
          "Never expose pseudo calls like default_api.list_local_files(...) in user-facing chat text.",
          "If you use tools, keep final user-facing text concise or empty when the action itself is enough."
        ].join("\n")
      : "";

    const finalSystem = [system, stickerModeInstruction, toolInstruction]
      .filter(Boolean)
      .join("\n\n");

    const parts: GeminiTextPart[] = [
      {
        text: [
          `Incoming message from ${context.senderJid} in ${context.chatJid}:`,
          context.text || context.media?.caption || "[media message]",
          context.media
            ? `Media: kind=${context.media.kind}, mime=${context.media.mimeType}, file=${context.media.fileName ?? "n/a"}, animated=${context.media.isAnimated ? "yes" : "no"}`
            : "Media: none",
          "Reply naturally. For multi-burst replies, separate chunks with |||."
        ].join("\n")
      }
    ];

    if (context.media) {
      parts.push({
        inline_data: {
          mime_type: context.media.mimeType,
          data: context.media.bytes.toString("base64")
        }
      });
    }

    if (!this.config.toolCallingEnabled) {
      const output = await this.gemini.generate({
        model: this.config.model,
        systemInstruction: finalSystem,
        parts,
        temperature: 0.6,
        maxOutputTokens: 180
      });
      return { replyText: normalizeReplyOutput(output), sentViaTools: 0 };
    }

    const tools = buildToolDeclarations(this.config);
    if (tools.length === 0) {
      const output = await this.gemini.generate({
        model: this.config.model,
        systemInstruction: finalSystem,
        parts,
        temperature: 0.6,
        maxOutputTokens: 180
      });
      return { replyText: normalizeReplyOutput(output), sentViaTools: 0 };
    }

    const conversation: GeminiConversationContent[] = [{ role: "user", parts }];
    const maxSteps = Math.max(1, Math.min(8, this.config.toolLoopMaxSteps));
    let sentViaTools = 0;

    for (let step = 0; step < maxSteps; step += 1) {
      const response = await this.gemini.generateWithTools({
        model: this.config.model,
        systemInstruction: finalSystem,
        contents: conversation,
        tools,
        temperature: 0.58,
        maxOutputTokens: 220
      });

      const textFallbackCalls =
        response.toolCalls.length === 0 ? parseLegacyTextToolCalls(response.text) : [];
      const effectiveCalls = response.toolCalls.length > 0 ? response.toolCalls : textFallbackCalls;

      if (effectiveCalls.length === 0) {
        return {
          replyText: normalizeReplyOutput(stripLegacyToolSyntax(response.text)),
          sentViaTools
        };
      }

      const toolResults: Array<Record<string, unknown>> = [];
      for (const call of effectiveCalls) {
        const result = await executeToolCall(call, {
          config: this.config,
          currentChatJid: context.chatJid,
          sendFile: async ({ chatJid, absolutePath, fileName, caption }) => {
            await this.sendLocalFile({ chatJid, absolutePath, fileName, caption });
          },
          sendStickerByQuery: async ({ chatJid, query }) => {
            return this.sendStickerByQuery({ chatJid, query });
          }
        });

        if (result.sentMessage) {
          sentViaTools += 1;
        }

        toolResults.push({
          name: call.name,
          ok: result.ok,
          message: result.message,
          sentMessage: Boolean(result.sentMessage),
          dataPreview: this.toolDataPreview(result.data)
        });
      }

      conversation.push({
        role: "model",
        parts: [
          {
            text:
              stripLegacyToolSyntax(response.text) ||
              `Executed ${effectiveCalls.length} tool call(s).`
          }
        ]
      });
      conversation.push({
        role: "user",
        parts: [{ text: `Tool call results (JSON):\n${JSON.stringify(toolResults)}` }]
      });
    }

    return { replyText: "", sentViaTools };
  }

  private writeHistory(context: IncomingContext, role: "incoming" | "outgoing"): void {
    const row: MessageRecord = {
      chatJid: context.chatJid,
      senderJid: context.senderJid,
      timestampISO: new Date().toISOString(),
      role,
      text: context.text || context.media?.caption || "[media]"
    };
    appendChatHistory(row);
  }

  private async parseIncoming(raw: BaileysMessage): Promise<IncomingContext | null> {
    const chatJid = raw?.key?.remoteJid as string | undefined;
    if (!chatJid) return null;

    const isGroup = chatJid.endsWith("@g.us");
    const senderJid = isGroup
      ? (raw?.key?.participant as string | undefined) ?? chatJid
      : chatJid;
    const message = raw?.message ?? {};

    const text =
      message?.conversation ??
      message?.extendedTextMessage?.text ??
      message?.imageMessage?.caption ??
      message?.videoMessage?.caption ??
      message?.documentMessage?.caption ??
      "";

    const mentionedJids: string[] =
      message?.extendedTextMessage?.contextInfo?.mentionedJid ??
      message?.imageMessage?.contextInfo?.mentionedJid ??
      message?.videoMessage?.contextInfo?.mentionedJid ??
      message?.documentMessage?.contextInfo?.mentionedJid ??
      [];

    const mentionedMe =
      this.ownJid.length > 0 &&
      mentionedJids.map((jid) => jidNormalizedUser(jid)).includes(this.ownJid);

    const media = await this.extractMedia(raw);

    return {
      chatJid,
      senderJid,
      isGroup,
      text: compactText(text),
      mentionedMe,
      media
    };
  }

  private async extractMedia(raw: BaileysMessage): Promise<IncomingContext["media"] | undefined> {
    const message = raw?.message ?? {};
    const candidate =
      message?.stickerMessage
        ? { kind: "sticker" as const, data: message.stickerMessage }
        : message?.documentMessage
        ? { kind: "document" as const, data: message.documentMessage }
        : message?.imageMessage
        ? { kind: "image" as const, data: message.imageMessage }
        : message?.audioMessage
        ? { kind: "audio" as const, data: message.audioMessage }
        : message?.videoMessage
        ? { kind: "video" as const, data: message.videoMessage }
        : undefined;

    if (!candidate) return undefined;

    const mimeType =
      (candidate.data?.mimetype as string | undefined) ??
      (candidate.kind === "sticker" ? "image/webp" : undefined);
    if (!mimeType) return undefined;
    if (!this.sock) return undefined;

    try {
      const bytes = (await downloadMediaMessage(
        raw,
        "buffer",
        {},
        {
          logger: this.logger,
          reuploadRequest: this.sock.updateMediaMessage
        }
      )) as Buffer;
      if (!bytes || bytes.length === 0) return undefined;
      if (bytes.length > this.config.maxInputMediaBytes) return undefined;

      return {
        kind: candidate.kind,
        mimeType,
        bytes,
        fileName:
          candidate.kind === "document"
            ? ((candidate.data?.fileName as string | undefined) ?? undefined)
            : undefined,
        isAnimated:
          candidate.kind === "video"
            ? Boolean(message?.videoMessage?.gifPlayback)
            : candidate.kind === "sticker"
            ? Boolean(message?.stickerMessage?.isAnimated)
            : undefined,
        caption: compactText(
          message?.imageMessage?.caption ??
            message?.videoMessage?.caption ??
            message?.documentMessage?.caption ??
            ""
        )
      };
    } catch (error) {
      this.logger.warn({ error }, "failed to download media");
      return undefined;
    }
  }

  private rememberIncomingSticker(
    chatJid: string,
    media: IncomingContext["media"] | undefined
  ): void {
    if (!media || media.kind !== "sticker") return;
    if (!this.config.allowForwardIncomingStickers) return;

    const list = this.recentIncomingStickersByChat.get(chatJid) ?? [];
    list.push({ bytes: media.bytes, mimeType: media.mimeType, at: Date.now() });
    while (list.length > 10) list.shift();
    this.recentIncomingStickersByChat.set(chatJid, list);
  }

  private toolDataPreview(data: unknown): string {
    if (data === undefined) return "";
    if (typeof data === "string") {
      return data.length > 1800 ? `${data.slice(0, 1800)}...` : data;
    }
    try {
      const serialized = JSON.stringify(data);
      if (!serialized) return "";
      return serialized.length > 1800 ? `${serialized.slice(0, 1800)}...` : serialized;
    } catch {
      return "[unserializable tool data]";
    }
  }

  private async sendLocalFile(args: {
    chatJid: string;
    absolutePath: string;
    fileName?: string;
    caption?: string;
  }): Promise<void> {
    if (!this.sock) throw new Error("socket not ready");

    const fileName = args.fileName ?? path.basename(args.absolutePath);
    const ext = path.extname(args.absolutePath).toLowerCase();
    const mime = guessMimeTypeFromPath(args.absolutePath);

    if (isImageExt(ext)) {
      await this.sock.sendMessage(
        args.chatJid,
        {
          image: { url: args.absolutePath },
          caption: args.caption
        },
        { useCachedGroupMetadata: false }
      );
      this.logMinimalFlow("ME", `${args.chatJid} | shared image: ${fileName}`);
      return;
    }

    if (isVideoExt(ext)) {
      await this.sock.sendMessage(
        args.chatJid,
        {
          video: { url: args.absolutePath },
          caption: args.caption
        },
        { useCachedGroupMetadata: false }
      );
      this.logMinimalFlow("ME", `${args.chatJid} | shared video: ${fileName}`);
      return;
    }

    if (isAudioExt(ext)) {
      await this.sock.sendMessage(
        args.chatJid,
        {
          audio: { url: args.absolutePath },
          mimetype: mime,
          ptt: false
        },
        { useCachedGroupMetadata: false }
      );
      this.logMinimalFlow("ME", `${args.chatJid} | shared audio: ${fileName}`);
      return;
    }

    await this.sock.sendMessage(
      args.chatJid,
      {
        document: { url: args.absolutePath },
        fileName,
        mimetype: mime,
        caption: args.caption
      },
      { useCachedGroupMetadata: false }
    );
    this.logMinimalFlow("ME", `${args.chatJid} | shared file: ${fileName}`);
  }

  private async sendStickerByQuery(args: {
    chatJid: string;
    query?: string;
  }): Promise<{ ok: boolean; message: string; source?: string }> {
    if (!this.sock) {
      return { ok: false, message: "socket not ready" };
    }

    const candidate = this.resolveStickerCandidate(args.chatJid, args.query);
    if (!candidate) {
      return {
        ok: false,
        message: "no sticker available (need incoming sticker or .webp in stickerPackDir)"
      };
    }

    try {
      await this.sock.sendMessage(
        args.chatJid,
        { sticker: candidate.bytes },
        { useCachedGroupMetadata: false }
      );
      this.logMinimalFlow("ME", `${args.chatJid} | sent sticker (${candidate.source})`);
      return {
        ok: true,
        message: `sticker sent via ${candidate.source}`,
        source: candidate.source
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `failed to send sticker: ${message}` };
    }
  }

  private resolveStickerCandidate(
    chatJid: string,
    query?: string
  ): { bytes: Buffer; source: string } | null {
    const normalizedQuery = compactText(query ?? "").toLowerCase();
    const preferRecent =
      !normalizedQuery ||
      ["recent", "same", "incoming", "react", "reply"].some((token) =>
        normalizedQuery.includes(token)
      );

    if (preferRecent && this.config.allowForwardIncomingStickers) {
      const recent = this.recentIncomingStickersByChat.get(chatJid);
      const latest = recent?.[recent.length - 1];
      if (latest?.bytes) {
        return { bytes: latest.bytes, source: "recent_incoming" };
      }
    }

    const pickedPath = this.pickStickerPackFile(normalizedQuery);
    if (pickedPath) {
      return {
        bytes: readFileSync(pickedPath),
        source: `pack:${path.basename(pickedPath)}`
      };
    }

    if (!preferRecent && this.config.allowForwardIncomingStickers) {
      const recent = this.recentIncomingStickersByChat.get(chatJid);
      const latest = recent?.[recent.length - 1];
      if (latest?.bytes) {
        return { bytes: latest.bytes, source: "recent_incoming_fallback" };
      }
    }

    return null;
  }

  private pickStickerPackFile(query: string): string | undefined {
    const root = this.config.stickerPackDir;
    if (!root || !existsSync(root) || !lstatSync(root).isDirectory()) {
      return undefined;
    }

    const all = collectStickerFiles(root, 3, 1000);
    if (all.length === 0) return undefined;

    const filtered =
      query.length > 0
        ? all.filter((file) => path.basename(file).toLowerCase().includes(query))
        : all;
    const pool = filtered.length > 0 ? filtered : all;
    const index = randomBetween(0, Math.max(0, pool.length - 1));
    return pool[index];
  }

  private directFallbackReply(inputText: string): string {
    if (!inputText.trim()) return "Oho, ping peyechi. Ki khobor bolun?";
    return "Bujhlam boss, ekdom noted. Aar bolo, ki scene?";
  }

  private isSelfSender(raw: BaileysMessage, senderJid: string): boolean {
    if (raw?.key?.fromMe) return true;
    if (this.isSelfSenderJid(senderJid)) return true;
    const participantPn =
      raw?.key?.participantPn ??
      raw?.message?.extendedTextMessage?.contextInfo?.participantPn ??
      raw?.message?.imageMessage?.contextInfo?.participantPn ??
      raw?.message?.videoMessage?.contextInfo?.participantPn;
    if (typeof participantPn === "string" && this.isSelfSenderJid(participantPn)) return true;
    return false;
  }

  private isSelfSenderJid(senderJid: string): boolean {
    const socketUserJid = jidNormalizedUser(this.sock?.user?.id ?? "");
    const own = [this.ownJid, socketUserJid, ...(this.config.selfSenderJids ?? [])].filter(
      Boolean
    );
    return isDirectJidAllowed(senderJid, own);
  }

  private rememberOutgoing(chatJid: string, text: string): void {
    const normalized = compactText(text);
    if (!normalized) return;
    const list = this.recentOutgoingByChat.get(chatJid) ?? [];
    list.push(normalized);
    while (list.length > 10) list.shift();
    this.recentOutgoingByChat.set(chatJid, list);
  }

  private isRecentOutgoing(chatJid: string, text: string): boolean {
    const list = this.recentOutgoingByChat.get(chatJid);
    if (!list || list.length === 0) return false;
    return list.includes(text);
  }

  private async maybeSendStartupProactiveMessages(): Promise<void> {
    if (!this.sock) return;
    if (!this.config.proactiveOnStartupEnabled) return;
    const targets = this.config.proactiveOnStartupDirectJids ?? [];
    if (targets.length === 0) return;

    for (const rawTarget of targets) {
      const targetJid = toDirectTargetJid(rawTarget);
      try {
        const text = await this.createProactiveStarter(targetJid);
        this.aiStage("REPLY", `startup proactive -> ${targetJid}: ${text.slice(0, 80)}`);
        await this.sock.sendPresenceUpdate("composing", targetJid);
        await sleep(randomBetween(900, 1800));
        await this.sock.sendPresenceUpdate("paused", targetJid);
        await this.sock.sendMessage(targetJid, { text });
        this.aiStage("SENT", `startup proactive sent -> ${targetJid}`);
      } catch (error) {
        this.logger.warn({ error, targetJid }, "failed startup proactive message");
      }
    }
  }

  private async createProactiveStarter(targetJid: string): Promise<string> {
    const memories = await this.memory.retrieve(targetJid, "conversation starter", 3);
    const memoryText =
      memories.length === 0
        ? "none"
        : memories.map((item, index) => `${index + 1}. ${item.fact}`).join("\n");
    const output = await this.gemini.generate({
      model: this.config.model,
      systemInstruction: [
        `You are ${this.config.botName}.`,
        "Write one short funny Banglish/Benglish WhatsApp opener.",
        "Keep it warm, casual, and natural. Max 1-2 short lines.",
        "No emojis spam. No NO_REPLY token."
      ].join("\n"),
      parts: [{ text: `Target JID: ${targetJid}\nRelevant memory:\n${memoryText}` }],
      temperature: 0.8,
      maxOutputTokens: 80
    });
    const cleaned = normalizeReplyOutput(output);
    return cleaned || "Ki re boss, bhalo? Ajke ki update?";
  }

  private aiStage(
    stage: "THINK" | "DECISION" | "REPLY" | "SENT" | "SKIP",
    message: string
  ): void {
    if (!this.verboseRuntimeLogs) return;
    this.logger.info({ stage, detail: message }, "ai stage");
  }

  private logMinimalFlow(
    role: "USER" | "AI" | "ME",
    detail: string,
    senderJid?: string
  ): void {
    if (this.verboseRuntimeLogs) return;
    const stamp = new Date().toISOString().slice(11, 19);
    const actorColor = senderJid ? colorForActor(senderJid) : "";
    const roleColor =
      role === "AI" ? ANSI_AI : role === "ME" ? ANSI_ME : actorColor || "\u001b[37m";
    const roleLabel = this.paint(`[${role}]`, roleColor);
    const timeLabel = this.paint(stamp, ANSI_DIM);
    const actorLabel = senderJid
      ? `${this.paint(shortActorLabel(senderJid), actorColor || "\u001b[37m")} `
      : "";
    console.log(`${timeLabel} ${roleLabel} ${actorLabel}${detail}`);
  }

  private paint(value: string, color: string): string {
    if (!this.colorEnabled || !color) return value;
    return `${color}${value}${ANSI_RESET}`;
  }
}

function collectStickerFiles(rootDir: string, maxDepth: number, maxFiles: number): string[] {
  const files: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];

  while (queue.length > 0 && files.length < maxFiles) {
    const current = queue.shift();
    if (!current) break;

    for (const entry of readdirSync(current.dir)) {
      const absolute = path.join(current.dir, entry);
      const isDir = lstatSync(absolute).isDirectory();
      if (isDir) {
        if (current.depth < maxDepth) {
          queue.push({ dir: absolute, depth: current.depth + 1 });
        }
        continue;
      }
      if (path.extname(absolute).toLowerCase() === ".webp") {
        files.push(absolute);
      }
      if (files.length >= maxFiles) break;
    }
  }

  return files;
}

function guessMimeTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".pdf":
      return "application/pdf";
    case ".txt":
      return "text/plain";
    case ".md":
      return "text/markdown";
    case ".json":
      return "application/json";
    case ".csv":
      return "text/csv";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".mp4":
      return "video/mp4";
    default:
      return "application/octet-stream";
  }
}

function isImageExt(ext: string): boolean {
  return [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"].includes(ext);
}

function isVideoExt(ext: string): boolean {
  return [".mp4", ".mov", ".mkv", ".webm"].includes(ext);
}

function isAudioExt(ext: string): boolean {
  return [".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"].includes(ext);
}

function parseLegacyTextToolCalls(text: string): GeminiToolCall[] {
  if (!text) return [];

  const allowedNames = new Set([
    "list_local_files",
    "read_local_file",
    "share_local_file",
    "send_sticker"
  ]);
  const calls: GeminiToolCall[] = [];
  const pattern =
    /(?:default_api\.)?(list_local_files|read_local_file|share_local_file|send_sticker)\s*\(([^)]*)\)/gi;

  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(text)) !== null) {
    const name = (match[1] ?? "").trim();
    if (!allowedNames.has(name)) continue;
    const args = parseLegacyToolArgs(match[2] ?? "");
    calls.push({ name, args });
  }

  return calls;
}

function parseLegacyToolArgs(raw: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const input = raw.trim();
  if (!input) return args;

  const keyValuePattern =
    /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*('[^']*'|"[^"]*"|`[^`]*`|[^,]+)(?:,|$)/g;
  let match: RegExpExecArray | null = null;
  while ((match = keyValuePattern.exec(input)) !== null) {
    const key = (match[1] ?? "").trim();
    const valueRaw = (match[2] ?? "").trim();
    if (!key) continue;
    args[key] = parseLegacyArgValue(valueRaw);
  }

  if (Object.keys(args).length === 0) {
    args.path = parseLegacyArgValue(input);
  }

  return args;
}

function parseLegacyArgValue(raw: string): unknown {
  const value = raw.trim();
  if (!value) return "";

  const wrappedBySingle = value.startsWith("'") && value.endsWith("'");
  const wrappedByDouble = value.startsWith('"') && value.endsWith('"');
  const wrappedByBacktick = value.startsWith("`") && value.endsWith("`");
  if (wrappedBySingle || wrappedByDouble || wrappedByBacktick) {
    return value.slice(1, -1);
  }

  const lowered = value.toLowerCase();
  if (lowered === "true") return true;
  if (lowered === "false") return false;

  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) {
    return asNumber;
  }

  return value;
}

function stripLegacyToolSyntax(text: string): string {
  if (!text) return "";
  const withoutCalls = text.replace(
    /`?\s*(?:default_api\.)?(list_local_files|read_local_file|share_local_file|send_sticker)\s*\([^`)]*\)\s*`?/gi,
    " "
  );
  return compactText(withoutCalls);
}

function inferMemoryFact(text: string): string | null {
  if (!text) return null;
  const low = text.toLowerCase();
  if (!low.includes("i ") && !low.includes("my ")) return null;
  if (text.length > 220) return null;
  return text;
}

export async function listJoinedGroups(): Promise<void> {
  const logger = pino({ level: "warn" });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    fireInitQueries: false,
    syncFullHistory: false,
    shouldIgnoreJid: shouldIgnoreIncomingJid,
    shouldSyncHistoryMessage: () => false,
    logger
  });

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", async (update: any) => {
    if (update?.qr) {
      console.log("\nScan this QR in WhatsApp > Linked devices:\n");
      qrcode.generate(update.qr, { small: true });
    }
    if (update?.connection === "open") {
      const rows = await fetchJoinedGroups(sock);
      console.log(JSON.stringify(rows, null, 2));
      process.exit(0);
    }
    if (update?.connection === "close") {
      const code = update?.lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.error("Logged out. Remove wa_auth and run again.");
        process.exit(1);
      }
      if (code === DisconnectReason.connectionReplaced || code === 440) {
        console.error("Connection replaced. Ensure only one Talky process is running.");
        process.exit(1);
      }
    }
  });

  await new Promise(() => undefined);
}

export async function listActiveGroups(config: AppConfig): Promise<void> {
  const logger = pino({ level: "warn" });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    fireInitQueries: false,
    syncFullHistory: false,
    shouldIgnoreJid: shouldIgnoreIncomingJid,
    shouldSyncHistoryMessage: () => false,
    logger
  });

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", async (update: any) => {
    if (update?.qr) {
      console.log("\nScan this QR in WhatsApp > Linked devices:\n");
      qrcode.generate(update.qr, { small: true });
    }
    if (update?.connection === "open") {
      const rows = await fetchJoinedGroups(sock);
      const active = rows.filter((group) => {
        if (config.mutedGroupJids.includes(group.jid)) return false;
        if (config.allowedGroupJids.length === 0) return true;
        return config.allowedGroupJids.includes(group.jid);
      });
      console.log(JSON.stringify(active, null, 2));
      process.exit(0);
    }
    if (update?.connection === "close") {
      const code = update?.lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.error("Logged out. Remove wa_auth and run again.");
        process.exit(1);
      }
      if (code === DisconnectReason.connectionReplaced || code === 440) {
        console.error("Connection replaced. Ensure only one Talky process is running.");
        process.exit(1);
      }
    }
  });

  await new Promise(() => undefined);
}

export async function sendDirectProactiveMessage(args: {
  target: string;
  config: AppConfig;
  env: AppEnv;
}): Promise<void> {
  const logger = pino({ level: "warn" });
  const targetJid = toDirectTargetJid(args.target);
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    fireInitQueries: false,
    syncFullHistory: false,
    shouldIgnoreJid: shouldIgnoreIncomingJid,
    shouldSyncHistoryMessage: () => false,
    logger
  });

  const gemini = new GeminiClient(args.env.geminiApiKey);
  const memory = new MemoryService(args.env.mem0ApiKey);

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", async (update: any) => {
    if (update?.qr) {
      console.log("\nScan this QR in WhatsApp > Linked devices:\n");
      qrcode.generate(update.qr, { small: true });
    }
    if (update?.connection === "open") {
      const memories = await memory.retrieve(targetJid, "conversation starter", 3);
      const memoryText =
        memories.length === 0
          ? "none"
          : memories.map((item, index) => `${index + 1}. ${item.fact}`).join("\n");
      let text = "Ki re boss, bhalo? Ajke ki update?";
      try {
        const output = await gemini.generate({
          model: args.config.model,
          systemInstruction: [
            `You are ${args.config.botName}.`,
            "Write one short funny Banglish/Benglish WhatsApp opener.",
            "Keep it warm, casual, and natural. Max 1-2 short lines.",
            "No NO_REPLY token."
          ].join("\n"),
          parts: [{ text: `Target JID: ${targetJid}\nRelevant memory:\n${memoryText}` }],
          temperature: 0.8,
          maxOutputTokens: 80
        });
        const cleaned = normalizeReplyOutput(output);
        if (cleaned) text = cleaned;
      } catch {
        // fallback text already set
      }

      await sock.sendPresenceUpdate("composing", targetJid);
      await sleep(randomBetween(900, 1800));
      await sock.sendPresenceUpdate("paused", targetJid);
      await sock.sendMessage(targetJid, { text });
      console.log(`Proactive message sent to ${targetJid}: ${text}`);
      process.exit(0);
    }
    if (update?.connection === "close") {
      const code = update?.lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.error("Logged out. Remove wa_auth and run again.");
        process.exit(1);
      }
      if (code === DisconnectReason.connectionReplaced || code === 440) {
        console.error("Connection replaced. Ensure only one Talky process is running.");
        process.exit(1);
      }
    }
  });

  await new Promise(() => undefined);
}

async function fetchJoinedGroups(
  sock: any
): Promise<Array<{ jid: string; name: string }>> {
  const groups = await sock.groupFetchAllParticipating();
  return Object.values(groups).map((group: any) => ({
    jid: group.id,
    name: group.subject
  }));
}

function isDirectJidAllowed(chatJid: string, allowlist: string[]): boolean {
  const incoming = buildDirectIdentifiers(chatJid);
  for (const raw of allowlist) {
    const allowed = buildDirectIdentifiers(raw);
    for (const value of allowed) {
      if (incoming.has(value)) return true;
    }
  }
  return false;
}

function buildDirectIdentifiers(input: string): Set<string> {
  const values = new Set<string>();
  const raw = input.trim().toLowerCase();
  if (!raw) return values;

  values.add(raw);
  const normalized = jidNormalizedUser(raw).toLowerCase();
  values.add(normalized);

  const userPart = normalized.split("@")[0];
  if (userPart) {
    values.add(userPart);
    values.add(`${userPart}@s.whatsapp.net`);
    values.add(`${userPart}@lid`);
  }

  return values;
}

function normalizeReplyOutput(raw: string): string {
  const trimmed = compactText(raw);
  if (!trimmed) return "";
  if (/^NO_REPLY$/i.test(trimmed)) return "";
  const withoutToken = compactText(trimmed.replace(/\bNO_REPLY\b/gi, ""));
  return withoutToken;
}

function splitReplyOutputToMessages(reply: string): string[] {
  const normalized = normalizeReplyOutput(reply);
  if (!normalized) return [];
  if (!normalized.includes("|||")) return [normalized];
  const cleaned = normalized
    .split("|||")
    .map((part) => compactText(part))
    .filter((part) => part.length > 0);
  if (cleaned.length === 0) return [normalized];
  return cleaned.slice(0, 2);
}

function toDirectTargetJid(input: string): string {
  const raw = input.trim();
  if (raw.includes("@")) return raw;
  return `${raw}@s.whatsapp.net`;
}
