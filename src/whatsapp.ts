import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  useMultiFileAuthState
} from "baileys";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { recordUnauthorized } from "./unauthorized";
import { AUTH_DIR, DATA_DIR } from "./config";
import type {
  AppConfig,
  AppEnv,
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
  type GeminiConversationPart,
  type GeminiConversationContent,
  type GeminiTextPart
} from "./gemini";
import { KlipyClient } from "./klipy";
import { decideReply } from "./decision";
import { buildReplySystemPrompt } from "./prompts";
import {
  appendExtractedFactToContactProfile,
  ensureContactProfile,
  ensureGroupProfile,
  ensurePersonaScaffold,
  loadPersonaContext
} from "./persona";
import { classifyMessageForMemory } from "./memory-extraction";
import { buildToolDeclarations, executeToolCall, type ToolRuntimeContext } from "./tool-executor";
import { appendToolActionLog } from "./tools";
import { compactText, randomBetween, sleep } from "./utils";
import { createEmbeddingProvider, type EmbeddingProvider } from "./embeddings";
import { Summarizer } from "./summarizer";
import { SelfChatAssistant } from "./self-chat";
import { normalizeJidInput } from "./jid";
import { Scheduler } from "./scheduler";
import { VoiceboxClient } from "./voice/voicebox-client";
import {
  installConsoleNoiseFilter,
  wrapLoggerWithNoiseFilter,
  type NoiseLogger
} from "./log-noise-filter";

installConsoleNoiseFilter();

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
const DEFAULT_GEMINI_TTS_MODEL = "gemini-2.5-flash-preview-tts";
const GEMINI_TTS_VOICES = [
  "Zephyr",
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Leda",
  "Orus",
  "Aoede",
  "Callirrhoe",
  "Autonoe",
  "Enceladus",
  "Iapetus",
  "Umbriel",
  "Algieba",
  "Despina",
  "Erinome",
  "Algenib",
  "Rasalgethi",
  "Laomedeia",
  "Achernar",
  "Alnilam",
  "Schedar",
  "Gacrux",
  "Pulcherrima",
  "Achird",
  "Zubenelgenubi",
  "Vindemiatrix",
  "Sadachbia",
  "Sadaltager",
  "Sulafat"
] as const;
const GEMINI_TTS_VOICE_LOOKUP = new Map(
  GEMINI_TTS_VOICES.map((voice) => [voice.toLowerCase(), voice])
);
const TTS_TMP_DIR = path.join(DATA_DIR, "tmp", "tts");

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

/** Boom / Baileys errors often put the real HTTP code in `data` (e.g. 429) while `output.statusCode` is 500. */
function boomHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const b = error as { data?: unknown; output?: { statusCode?: unknown } };
  if (typeof b.data === "number" && b.data >= 400 && b.data < 600) return b.data;
  const sc = b.output?.statusCode;
  if (typeof sc === "number" && sc >= 400 && sc < 600) return sc;
  return undefined;
}

export class WhatsAppAgent {
  private readonly logger: ReturnType<typeof pino>;
  private verboseRuntimeLogs: boolean;
  private readonly gemini: GeminiClient;
  private readonly klipy: KlipyClient | null;
  private readonly voicebox: VoiceboxClient | null;
  private readonly memory: MemoryService;
  private readonly embeddings: EmbeddingProvider;
  private readonly summarizer: Summarizer;
  private readonly selfChat: SelfChatAssistant;
  private readonly scheduler: Scheduler;
  private schedulerStarted = false;
  private sock: BaileysSocket | null = null;
  private ownJid = "";
  /** Linked @lid for this account (from signal LID map), merged into self-identity checks. */
  private ownLidHintJid = "";
  private connectedAtMs = 0;
  private readonly recentOutgoingByChat = new Map<string, string[]>();
  private readonly recentIncomingStickersByChat = new Map<
    string,
    Array<{ bytes: Buffer; mimeType: string; at: number }>
  >();
  private groupsCache: { at: number; rows: Array<{ jid: string; name: string }> } = {
    at: 0,
    rows: []
  };
  /** After 429 from `groupFetchAllParticipating`, do not call WA again until this time (epoch ms). */
  private groupsRateLimitUntil = 0;
  /** Deduplicate concurrent `getGroups` fetches (UI often fires several requests at once). */
  private groupsFetchInFlight: Promise<Array<{ jid: string; name: string }>> | null = null;
  private sentCount = 0;
  private sentDay = new Date().toISOString().slice(0, 10);
  private readonly colorEnabled = Boolean(process.stdout.isTTY);
  private proactiveStartupTriggered = false;
  private readonly groupPermissionCache = new Map<
    string,
    { ts: number; allowed: boolean; reason: string }
  >();
  /** Latest Baileys pairing string for the web console; cleared on connect or session close. */
  private latestSessionQr: string | null = null;
  private waConnectionState: "open" | "close" | "connecting" | null = null;
  /** Bumped on each `start()` so Baileys handlers from replaced sockets ignore stale `connection.update` events (those could clear `latestSessionQr` after a new QR appeared). */
  private waSocketGeneration = 0;
  /** When true, a `loggedOut` close from `relinkSession()` restarts `start()` so a new QR can appear. */
  private relinkRestartPending = false;

  constructor(
    private config: AppConfig,
    private readonly env: AppEnv
  ) {
    this.verboseRuntimeLogs = config.runtimeLogMode === "verbose";
    this.logger = pino({ level: this.verboseRuntimeLogs ? "info" : "warn" });
    ensurePersonaScaffold();
    this.gemini = new GeminiClient(env.geminiApiKey);
    this.klipy = env.klipyAppKey ? new KlipyClient(env.klipyAppKey) : null;
    this.voicebox =
      env.voiceboxBaseUrl && env.voiceboxProfileId
        ? new VoiceboxClient({ baseUrl: env.voiceboxBaseUrl })
        : null;
    this.embeddings = config.memoryEmbeddingsEnabled
      ? createEmbeddingProvider(env.geminiApiKey)
      : createEmbeddingProvider(undefined);
    this.memory = new MemoryService({
      mem0ApiKey: env.mem0ApiKey,
      embeddings: this.embeddings,
      backend: config.memoryBackend ?? "hybrid"
    });
    this.summarizer = new Summarizer(this.gemini);
    this.selfChat = new SelfChatAssistant({
      getConfig: () => this.config,
      getOwnerJid: () => this.ownJid,
      gemini: this.gemini,
      summarizer: this.summarizer,
      memory: this.memory,
      resolveGroupLabel: (jid) => this.resolveGroupLabel(jid),
      resolveGroupJid: (query) => this.resolveGroupJidByQuery(query),
      updateConfigSnapshot: (next) => {
        this.config = next;
        this.verboseRuntimeLogs = next.runtimeLogMode === "verbose";
      },
      getToolDeclarations: () =>
        buildToolDeclarations(this.config, { enableKlipyGif: Boolean(this.klipy) }),
      runTool: (call, chatJid, senderJid) =>
        executeToolCall(call, this.buildToolRuntime(chatJid, senderJid))
    });
    this.scheduler = new Scheduler({
      config: () => this.config,
      ownerJid: () => this.ownJid,
      summarizer: this.summarizer,
      memory: this.memory,
      embeddings: this.embeddings,
      callbacks: {
        sendDirectMessage: (jid, text) => this.sendProactiveText(jid, text),
        resolveGroupLabel: (jid) => this.resolveGroupLabel(jid)
      },
      logger: {
        info: (payload, label) => this.logger.info(payload, label ?? "scheduler"),
        warn: (payload, label) => this.logger.warn(payload, label ?? "scheduler")
      }
    });
  }

  async start(): Promise<void> {
    this.waSocketGeneration++;
    const socketGeneration = this.waSocketGeneration;
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
      logger: wrapLoggerWithNoiseFilter(
        this.logger.child({ module: "baileys" }) as unknown as NoiseLogger
      ) as unknown as ReturnType<typeof this.logger.child>
    });

    this.sock.ev.on("creds.update", (...args: Parameters<typeof saveCreds>) => {
      if (socketGeneration !== this.waSocketGeneration) return;
      void saveCreds(...args);
    });
    this.sock.ev.on("connection.update", async (update: any) => {
      if (socketGeneration !== this.waSocketGeneration) return;
      const { connection, qr, lastDisconnect } = update;
      if (qr) {
        this.latestSessionQr = qr;
        this.waConnectionState = "connecting";
        console.log("\nScan this QR in WhatsApp > Linked devices:\n");
        qrcode.generate(qr, { small: true });
      }
      if (connection === "open") {
        this.latestSessionQr = null;
        this.waConnectionState = "open";
        this.ownJid = jidNormalizedUser(this.sock?.user?.id ?? "");
        this.connectedAtMs = Date.now();
        this.refreshOwnLidHintFromSignal();
        console.log(`Connected as ${this.ownJid}`);
        const graceSeconds = Math.max(0, this.config.startupGraceSeconds ?? 20);
        if (graceSeconds > 0) {
          console.log(
            `Startup grace: ignoring inbound messages for ${graceSeconds}s while Baileys flushes any offline backlog.`
          );
          const scheduledConnectAt = this.connectedAtMs;
          setTimeout(() => {
            if (this.connectedAtMs !== scheduledConnectAt) return;
            console.log(`\n[READY] Listening for new messages as ${this.ownJid}.\n`);
          }, graceSeconds * 1000).unref?.();
        } else {
          console.log(`\n[READY] Listening for new messages as ${this.ownJid}.\n`);
        }
        if (!this.schedulerStarted) {
          this.schedulerStarted = true;
          this.scheduler.start();
          void this.memory.ensureReady().catch(() => undefined);
        }
        if (!this.proactiveStartupTriggered) {
          this.proactiveStartupTriggered = true;
          await this.maybeSendStartupProactiveMessages();
        }
      }
      if (typeof connection !== "undefined" && connection !== "open") {
        if (connection === "close") {
          this.latestSessionQr = null;
          this.waConnectionState = "close";
        } else if (connection === "connecting") {
          this.waConnectionState = "connecting";
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
          this.latestSessionQr = null;
          if (this.relinkRestartPending) {
            this.relinkRestartPending = false;
            console.log("Relink: reconnecting — scan QR in WhatsApp › Linked devices, or check the Talky console.");
            await sleep(900);
            await this.start();
            return;
          }
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

    this.sock.ev.on("messages.upsert", ({ messages, type }: any) => {
      if (socketGeneration !== this.waSocketGeneration) return;
      // Baileys emits upserts with two types:
      //   - "notify": genuinely new real-time messages → process normally
      //   - "append": historical/offline backfill → skip entirely (prevents spam-reply storm on reconnect)
      if (type && type !== "notify") {
        this.logger.info(
          { upsertType: type, count: Array.isArray(messages) ? messages.length : 0 },
          "skipping non-notify upsert batch"
        );
        return;
      }
      for (const message of messages as BaileysMessage[]) {
        if (this.shouldDropMessage(message)) continue;
        this.dispatchInboundMessage(message);
      }
    });
  }

  // Returns true when the message should be silently discarded before inbound
  // handling. Protects against stale historical messages; startup
  // grace is handled later (after unauthorized/inbox recording) so blocked
  // senders still appear in the inbox during reconnect.
  private shouldDropMessage(raw: BaileysMessage): boolean {
    if (!raw?.message) return false;
    if (raw?.key?.fromMe === true) return false; // self-sent loop-guard path handles these
    // Startup grace is applied later in handleMessage after policy/unauthorized recording,
    // so blocked contacts still populate the inbox during the grace window.
    const staleLimit = Math.max(0, this.config.staleMessageMaxAgeSeconds ?? 0);
    if (staleLimit > 0) {
      const tsSeconds = extractMessageTimestampSeconds(raw?.messageTimestamp);
      if (tsSeconds !== null) {
        const ageSeconds = Math.floor(Date.now() / 1000) - tsSeconds;
        if (ageSeconds > staleLimit) {
          this.logger.info(
            {
              msgId: raw?.key?.id,
              chatJid: raw?.key?.remoteJid,
              ageSeconds,
              staleLimit
            },
            "skipping stale message (older than staleMessageMaxAgeSeconds)"
          );
          return true;
        }
      }
    }
    return false;
  }

  /** Same timing as legacy shouldDrop grace — skips processing for allowed chats only (caller gates on policy). */
  private shouldSkipInboundDuringStartupGrace(raw: BaileysMessage): boolean {
    if (!raw?.message) return false;
    if (raw?.key?.fromMe === true) return false;
    const graceSeconds = Math.max(0, this.config.startupGraceSeconds ?? 0);
    if (graceSeconds > 0 && this.connectedAtMs > 0) {
      const sinceConnectMs = Date.now() - this.connectedAtMs;
      if (sinceConnectMs < graceSeconds * 1000) {
        return true;
      }
    }
    return false;
  }

  /** Resolve WhatsApp's PN→LID map once after connect so self-chat matches @lid notebook chats without manual config. */
  private refreshOwnLidHintFromSignal(): void {
    void (async () => {
      try {
        const sock = this.sock;
        if (!sock || !this.ownJid) return;
        const lidStore = (
          sock as {
            signalRepository?: {
              lidMapping?: { getLIDForPN?: (pn: string) => Promise<string | undefined> };
            };
          }
        ).signalRepository?.lidMapping;
        if (!lidStore?.getLIDForPN) return;
        const pn = this.ownJid.includes("@") ? this.ownJid : `${this.ownJid}@s.whatsapp.net`;
        const lid = await lidStore.getLIDForPN(pn);
        if (typeof lid !== "string" || !lid) return;
        const first = lid.split(":")[0] ?? "";
        const lidJid = first.endsWith("@lid") ? first : lid;
        if (lidJid.endsWith("@lid")) {
          this.ownLidHintJid = jidNormalizedUser(lidJid);
        }
      } catch {
        // optional; config selfSenderJids still works
      }
    })();
  }

  private dispatchInboundMessage(message: BaileysMessage): void {
    const chatJid = (message?.key?.remoteJid as string | undefined) ?? "__unknown__";
    void this.handleMessage(message).catch((error) => {
      this.logger.error({ error, chatJid }, "failed to process message");
    });
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
      const allowed = isGroupJidAllowed(chatJid, this.config.allowedGroupJids);
      return {
        allowed,
        reason: allowed
          ? "group matched allowlist"
          : "group not in allowedGroupJids"
      };
    }
    // Self-chat (notebook): allow when enabled and DM peer matches any linked identity (@s.whatsapp.net / @lid / selfSenderJids).
    if (this.config.selfChatEnabled && this.ownJid.length > 0 && this.isSelfSenderJid(chatJid)) {
      return { allowed: true, reason: "self-chat allowed (selfChatEnabled=true)" };
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

  public async getGroups(forceRefresh = false): Promise<{ jid: string; name: string }[]> {
    if (!this.sock) return this.groupsCache.rows;

    const now = Date.now();
    const cacheTtlMs = 60_000;
    const rateLimitBackoffMs = 300_000;

    if (!forceRefresh && this.groupsCache.rows.length > 0) {
      if (now < this.groupsRateLimitUntil) {
        return this.groupsCache.rows;
      }
      if (now - this.groupsCache.at < cacheTtlMs) {
        return this.groupsCache.rows;
      }
    }

    if (forceRefresh && now < this.groupsRateLimitUntil && this.groupsCache.rows.length > 0) {
      this.logger.info("skipping forced group list refresh during WhatsApp rate-limit backoff");
      return this.groupsCache.rows;
    }

    if (this.groupsFetchInFlight) {
      return this.groupsFetchInFlight;
    }

    const sock = this.sock;
    this.groupsFetchInFlight = (async () => {
      try {
        const rows = await fetchJoinedGroups(sock);
        const at = Date.now();
        this.groupsCache = { at, rows };
        this.groupsRateLimitUntil = 0;
        return rows;
      } catch (error) {
        const at = Date.now();
        const status = boomHttpStatus(error);
        this.groupsCache = { ...this.groupsCache, at };
        if (status === 429) {
          this.groupsRateLimitUntil = at + rateLimitBackoffMs;
          this.logger.warn(
            { retryAfterMs: rateLimitBackoffMs },
            "WhatsApp rate-limited group list (429); using cached groups — longer backoff until retry"
          );
        } else {
          this.logger.warn({ error, status }, "failed to fetch groups; returning cached groups");
        }
        return this.groupsCache.rows;
      } finally {
        this.groupsFetchInFlight = null;
      }
    })();

    return this.groupsFetchInFlight;
  }
  
  public async relinkSession(): Promise<void> {
    if (!this.sock) return;
    this.relinkRestartPending = true;
    try {
      await this.sock.logout();
    } catch (err) {
      this.relinkRestartPending = false;
      throw err;
    }
  }

  /** Snapshot for `GET /api/status` — Baileys QR string and connection hints. */
  public getUiSessionSnapshot(): {
    whatsappQr: string | null;
    whatsappNeedsQr: boolean;
    whatsappConnected: boolean;
    whatsappConnection: "open" | "close" | "connecting" | null;
  } {
    const connected =
      this.waConnectionState === "open" && Boolean(this.sock?.user?.id);
    return {
      whatsappQr: this.latestSessionQr,
      whatsappNeedsQr: this.latestSessionQr !== null,
      whatsappConnected: connected,
      whatsappConnection: this.waConnectionState
    };
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
    const remoteJid = raw?.key?.remoteJid as string | undefined;
    if (!remoteJid) return;
    if (remoteJid === "status@broadcast") return;
    if (remoteJid.endsWith("@newsletter") || remoteJid.endsWith("@broadcast")) {
      this.logger.info({ msgId: raw?.key?.id, chatJid: remoteJid }, "skipping newsletter/broadcast");
      return;
    }

    // Self-chat detection: fromMe=true AND remoteJid is one of our own identities
    // (ownJid, socket user jid, or any selfSenderJids entry — covers phone and @lid
    // forms). In groups remoteJid ends with @g.us so this never matches there.
    const isSelfChat =
      raw?.key?.fromMe === true &&
      !remoteJid.endsWith("@g.us") &&
      this.isSelfSenderJid(remoteJid);

    if (isSelfChat && !this.config.selfChatEnabled) {
      this.logger.info(
        { msgId: raw?.key?.id, chatJid: remoteJid },
        "skipping self-chat (selfChatEnabled=false)"
      );
      return;
    }

    const context = await this.parseIncoming(raw);
    if (!context) return;
    this.rememberIncomingSticker(context.chatJid, context.media);
    const incomingText = compactText(context.text || context.media?.caption || "");

    // You sent this from the phone app (not the self-chat notebook) — update inbox + chat files, never run the bot.
    if (raw?.key?.fromMe === true && !isSelfChat) {
      const rawPushManual = (raw as { pushName?: string } | undefined)?.pushName;
      const inboxNameManual = context.isGroup
        ? this.resolveGroupLabel(context.chatJid)
        : this.resolveContactDisplayName(context.chatJid, rawPushManual) ?? rawPushManual;
      const policyManual = this.evaluateChatPolicy(context.chatJid, context.isGroup);
      if (!policyManual.allowed && policyManual.reason !== "self message") {
        recordUnauthorized(
          context.chatJid,
          context.isGroup,
          policyManual.reason,
          inboxNameManual || undefined,
          incomingText || undefined
        );
      }
      if (this.config.recordManualOutboundMessages) {
        const ownerJid = this.getEffectiveOwnJid();
        if (ownerJid) {
          this.writeManualOutboundHistory(context, ownerJid);
        }
      }
      this.logger.info(
        { msgId: raw?.key?.id, chatJid: context.chatJid, preview: previewText(incomingText || "[media]") },
        "manual outbound from WhatsApp; skipping bot reply path"
      );
      return;
    }

    if (incomingText && this.isRecentOutgoing(context.chatJid, incomingText)) {
      this.logger.warn(
        { msgId: raw?.key?.id, chatJid: context.chatJid, textPreview: incomingText.slice(0, 80) },
        "skipping echo of recently-sent outgoing message (loop guard)"
      );
      return;
    }
    // In group chats, skip own messages. In self-chat mode, never skip (we are the user).
    if (context.isGroup && this.isSelfSender(raw, context.senderJid)) {
      this.logger.info(
        { msgId: raw?.key?.id, chatJid: context.chatJid, senderJid: context.senderJid },
        "skipping own group message (self sender id)"
      );
      return;
    }
    if (!context.isGroup && !isSelfChat && this.isSelfSender(raw, context.senderJid)) {
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
    const rawPush = (raw as { pushName?: string } | undefined)?.pushName;
    const inboxName = context.isGroup
      ? this.resolveGroupLabel(context.chatJid)
      : this.resolveContactDisplayName(context.chatJid, rawPush) ?? rawPush;

    const policy = this.evaluateChatPolicy(context.chatJid, context.isGroup);
    if (!policy.allowed) {
      if (policy.reason !== "self message") {
        recordUnauthorized(
          context.chatJid,
          context.isGroup,
          policy.reason,
          inboxName || undefined,
          incomingText || undefined
        );
      }
      if (this.config.appendHistoryForDisallowedChats) {
        this.writeHistory(context, "incoming");
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

    if (!isSelfChat && this.shouldSkipInboundDuringStartupGrace(raw)) {
      this.logger.info(
        { msgId: raw?.key?.id, chatJid: context.chatJid },
        "skipping allowed chat during startup grace (suppress reply/history)"
      );
      return;
    }

    if (isSelfChat && this.config.selfChatEnabled && incomingText) {
      this.writeHistory(context, "incoming");
      const handled = await this.handleSelfChatMessage(context, incomingText, raw);
      if (handled) return;
    }

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

    await this.persistIncomingAutoMemory(context);
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

  /** Heuristic prefilter + Gemini classification, dedup, per-contact profile line, owner copy in groups. */
  private async persistIncomingAutoMemory(context: IncomingContext): Promise<void> {
    const prefilter = inferMemoryFact(context.text);
    if (!prefilter) return;

    let fact = prefilter;
    let confidence = 0.7;

    const extracted = await classifyMessageForMemory(this.gemini, this.config.model, context.text, {
      senderJid: context.senderJid,
      isGroup: context.isGroup,
      chatLabel: context.groupName
    });
    if (extracted) {
      if (!extracted.store || !extracted.fact.trim()) return;
      fact = extracted.fact.trim();
      confidence = extracted.confidence;
    }

    if (!(await this.memory.isNearDuplicate(context.senderJid, fact))) {
      await this.memory.remember(context.senderJid, fact, "chat_auto", { confidence });
      appendExtractedFactToContactProfile(context.senderJid, fact);
    }

    if (context.isGroup && this.ownJid) {
      const senderLabel = this.resolveGroupLabel(context.senderJid);
      const groupLabel = this.resolveGroupLabel(context.chatJid);
      const ownerFact = `[from ${senderLabel} in ${groupLabel}] ${fact}`;
      const dupOwner = await this.memory.isNearDuplicate(this.ownJid, ownerFact);
      if (!dupOwner) {
        await this.memory.remember(this.ownJid, ownerFact, "group_mention", { confidence });
      }
    }
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
        ? "Default behavior: use sticker actions first. Prefer send_sticker and send_klipy_gif for reactions; use plain text only when sticker/GIF cannot carry the intent."
        : this.config.stickerReplyMode === "explicit-only"
        ? "Use send_sticker only when user explicitly asks for a sticker/reaction."
        : "Prefer sticker-based reactions for emotional/chill replies; use text for factual or complex replies.";

    const toolInstructionLines = [
      "You may use tools when useful:",
      "- list_available_tools: list exact callable tool names currently available.",
      "- list_local_files: inspect allowed local folders.",
      "- read_local_file: read an allowed file within size limits.",
      "- share_local_file: send local file(s) to chat; folder path can send multiple images/files.",
      "- send_sticker: send a sticker from recent incoming or local sticker pack.",
      "- send_voice_reply: send PTT-style voice note from text.",
      "- send_image_reply: generate and send an image reply.",
      "- send_meme_reply: generate and send meme-style image reaction.",
      "- send_styled_quote_card: generate and send stylish quote-card image.",
      "- send_voice_plus_text: send voice note and short text together.",
      "- send_reaction_combo: auto-choose sticker, GIF, or voice reaction by tone.",
      "Prefer sticker-focused tools for reactions: use send_sticker first, then send_gif/send_klipy_gif for animated/contextual GIF reactions when available."
    ];
    if (this.klipy) {
      toolInstructionLines.push(
        "- send_gif / send_klipy_gif: search KLIPY and send one relevant reaction GIF.",
        "If incoming media is animated (gif/video/sticker) and a reaction is needed, prefer send_gif with a short vibe query."
      );
    }
    toolInstructionLines.push(
      "If user asks which tools you can call (for example: tool list, ki ki tool call korte paris), first call list_available_tools and then answer from its result.",
      "Use tools autonomously when needed, and chain multiple tool calls in one reply flow if it improves the result.",
      "When a tool is needed, execute it first and do not pretend it already happened.",
      "Never expose tool syntax or function-call JSON in user-facing chat text.",
      "If you use tools, keep final user-facing text concise or empty when the action itself is enough.",
      "HARD RULE — no narrated tool use: if your reply text mentions or implies sending/sharing a sticker, voice note, GIF, image, meme, or file (phrases like 'sticker pathachchi', 'ekta sticker send kori', 'sending sticker', 'ei nao sticker', 'sending voice', 'wait, sending gif', 'ekhoni pathachchi', etc.), you MUST call the matching tool (send_sticker / send_voice_reply / send_gif / send_image_reply / send_meme_reply / share_local_file) in the SAME turn. Narrating the action without invoking the tool is a failure — either call the tool or don't mention the action."
    );

    const toolInstruction = this.config.toolCallingEnabled ? toolInstructionLines.join("\n") : "";

    const finalSystem = [system, stickerModeInstruction, toolInstruction]
      .filter(Boolean)
      .join("\n\n");

    const audioUnderstanding =
      context.media?.kind === "audio"
        ? await this.describeIncomingAudio(context.media)
        : "";
    const mediaSummary = context.media
      ? `Media: kind=${context.media.kind}, mime=${context.media.mimeType}, file=${context.media.fileName ?? "n/a"}, animated=${context.media.isAnimated ? "yes" : "no"}`
      : "Media: none";

    const parts: GeminiTextPart[] = [
      {
        text: [
          `Incoming message from ${context.senderJid} in ${context.chatJid}:`,
          context.text || context.media?.caption || "[media message]",
          mediaSummary,
          audioUnderstanding ? `Audio insight: ${audioUnderstanding}` : "",
          "Reply naturally. For multi-burst replies, separate chunks with |||."
        ]
          .filter(Boolean)
          .join("\n")
      }
    ];

    if (context.media) {
      parts.push({
        inline_data: {
          mime_type: normalizeGeminiInlineMimeType(context.media.mimeType),
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

    const tools = buildToolDeclarations(this.config, {
      enableKlipyGif: Boolean(this.klipy)
    });
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
    const toolRuntime = this.buildToolRuntime(
      context.chatJid,
      context.senderJid,
      tools.map((tool) => tool.name)
    );

    const incomingIntentText = context.text || context.media?.caption || "";
    const explicitTextCalls = parseTextToolCalls(incomingIntentText);
    const explicitVoiceCall = explicitTextCalls.find(
      (call) => call.name === "send_voice_reply" || call.name === "end_voice_reply"
    );
    if (explicitVoiceCall || isExplicitVoiceToolIntent(incomingIntentText)) {
      const voiceArgs = {
        ...(explicitVoiceCall?.args ?? {}),
        text:
          compactText(String(explicitVoiceCall?.args?.text ?? "")) ||
          defaultExplicitVoiceReplyText()
      };

      const explicitVoiceResult = await executeToolCall(
        {
          name: "send_voice_reply",
          args: voiceArgs
        },
        toolRuntime
      );

      if (explicitVoiceResult.sentMessage) {
        return { replyText: "", sentViaTools: sentViaTools + 1 };
      }

      return {
        replyText: `Voice message send failed: ${explicitVoiceResult.message}`,
        sentViaTools
      };
    }

    if (isToolListIntent(context.text || context.media?.caption || "")) {
      const inventoryResult = await executeToolCall(
        {
          name: "list_available_tools",
          args: {}
        },
        toolRuntime
      );
      const names =
        (inventoryResult.data as { tools?: string[] } | undefined)?.tools?.filter(Boolean) ?? [];
      if (names.length > 0) {
        return {
          replyText: `Ami ei tool gula call korte pari:\n- ${names.join("\n- ")}`,
          sentViaTools
        };
      }
    }

    for (let step = 0; step < maxSteps; step += 1) {
      const response = await this.gemini.generateWithTools({
        model: this.config.model,
        systemInstruction: finalSystem,
        contents: conversation,
        tools,
        temperature: 0.58,
        maxOutputTokens: 220
      });

      const fallbackTextCalls =
        response.toolCalls.length === 0
          ? parseTextToolCalls(response.text)
          : [];
      const effectiveToolCalls =
        response.toolCalls.length > 0 ? response.toolCalls : fallbackTextCalls;
      const sanitizedResponseText = stripParsedToolCallText(response.text);

      if (effectiveToolCalls.length === 0) {
        const narratedGifQuery = extractNarratedGifQuery(
          sanitizedResponseText,
          incomingIntentText || context.media?.caption || ""
        );
        if (narratedGifQuery && this.klipy) {
          const gifResult = await executeToolCall(
            {
              name: "send_gif",
              args: {
                query: narratedGifQuery
              }
            },
            toolRuntime
          );
          if (gifResult.sentMessage) {
            sentViaTools += 1;
            appendToolActionLog({
              tool: "tool_planner",
              ok: true,
              chatJid: context.chatJid,
              message: `step=${step + 1} | decision=auto_send_gif | query=${narratedGifQuery}`
            });
            return { replyText: "", sentViaTools };
          }
        }

        appendToolActionLog({
          tool: "tool_planner",
          ok: true,
          chatJid: context.chatJid,
          message: `step=${step + 1} | decision=no_tool_call | text=${compactText(sanitizedResponseText || "(empty)").slice(0, 140)}`
        });
        return {
          replyText: normalizeReplyOutput(sanitizedResponseText),
          sentViaTools
        };
      }

      appendToolActionLog({
        tool: "tool_planner",
        ok: true,
        chatJid: context.chatJid,
        message: `step=${step + 1} | decision=call_tool | names=${effectiveToolCalls
          .map((call) => call.name)
          .join(",")}`
      });

      const toolResults: Array<Record<string, unknown>> = [];
      const functionResponseParts: GeminiConversationPart[] = [];
      for (const call of effectiveToolCalls) {
        const result = await executeToolCall(call, toolRuntime);

        if (result.sentMessage) {
          sentViaTools += 1;
        }

        toolResults.push({
          id: call.id,
          name: call.name,
          ok: result.ok,
          message: result.message,
          sentMessage: Boolean(result.sentMessage),
          dataPreview: this.toolDataPreview(result.data)
        });

        functionResponseParts.push({
          functionResponse: {
            id: call.id,
            name: call.name,
            response: {
              ok: result.ok,
              message: result.message,
              sentMessage: Boolean(result.sentMessage),
              dataPreview: this.toolDataPreview(result.data)
            }
          }
        });
      }

      // Use the real SDK parts (including functionCall) so the model knows what it called.
      // Fall back to plain text only if no parts came back (shouldn't happen).
      const modelHistoryParts: GeminiConversationPart[] =
        response.modelParts.length > 0
          ? response.modelParts
          : [{ text: sanitizedResponseText || `Executed ${effectiveToolCalls.length} tool call(s).` }];

      conversation.push({
        role: "model",
        parts: modelHistoryParts
      });
      conversation.push({
        role: "user",
        parts:
          functionResponseParts.length > 0
            ? functionResponseParts
            : [{ text: `Tool call results (JSON):\n${JSON.stringify(toolResults)}` }]
      });
    }

    return { replyText: "", sentViaTools };
  }

  private async describeIncomingAudio(
    media: NonNullable<IncomingContext["media"]>
  ): Promise<string> {
    if (media.kind !== "audio") return "";
    try {
      const summary = await this.gemini.generate({
        model: this.config.model,
        systemInstruction:
          "You analyze short WhatsApp audio clips. Return one compact line with: what was said, tone, and intent.",
        parts: [
          {
            text:
              "Understand this incoming audio. Output only concise factual understanding. No markdown, no bullet points."
          },
          {
            inline_data: {
              mime_type: normalizeGeminiInlineMimeType(media.mimeType),
              data: media.bytes.toString("base64")
            }
          }
        ],
        temperature: 0.1,
        maxOutputTokens: 140
      });
      return compactText(summary).slice(0, 280);
    } catch (error) {
      this.logger.warn(
        { error, mimeType: media.mimeType },
        "audio understanding pre-pass failed"
      );
      return "";
    }
  }

  private getEffectiveOwnJid(): string {
    if (this.ownJid && this.ownJid.length > 0) return this.ownJid;
    const id = this.sock?.user?.id;
    return id ? jidNormalizedUser(String(id)) : "";
  }

  private writeManualOutboundHistory(context: IncomingContext, ownerJid: string): void {
    const row: MessageRecord = {
      chatJid: context.chatJid,
      senderJid: ownerJid,
      timestampISO: new Date().toISOString(),
      role: "outgoing",
      text: context.text || context.media?.caption || "[media]",
      manualOutbound: true
    };
    appendChatHistory(row);
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

  private buildToolRuntime(
    chatJid: string,
    senderJid: string,
    availableToolNames?: string[]
  ): ToolRuntimeContext {
    return {
      config: this.config,
      currentChatJid: chatJid,
      currentSenderJid: senderJid,
      availableToolNames,
      sendFile: async ({ chatJid: target, absolutePath, fileName, caption }) => {
        await this.sendLocalFile({ chatJid: target, absolutePath, fileName, caption });
      },
      sendStickerByQuery: async ({ chatJid: target, query }) => {
        return this.sendStickerByQuery({ chatJid: target, query });
      },
      sendKlipyGifByQuery: async ({
        chatJid: target,
        query,
        customerId,
        locale,
        contentFilter,
        perPage
      }) => {
        return this.sendKlipyGifByQuery({
          chatJid: target,
          query,
          customerId,
          locale,
          contentFilter,
          perPage
        });
      },
      sendVoiceReply: async (args) => {
        return this.sendVoiceReply(args);
      },
      sendImageReply: async (args) => {
        return this.sendImageReply(args);
      },
      sendTextMessage: async ({ chatJid: target, text }) => {
        await this.sendToolTextMessage({ chatJid: target, text });
      },
      rememberFact: async ({ fact, scope, source }) => {
        const targetScope = scope === "sender" ? "sender" : "owner";
        const scopeJid =
          targetScope === "owner" ? this.ownJid || senderJid : senderJid;
        const tag = source || "tool_call";
        await this.memory.remember(scopeJid, fact, tag);
        return {
          ok: true,
          message: `remembered for ${targetScope} (${scopeJid})`,
          data: { scopeJid, source: tag }
        };
      },
      recallMemory: async ({ query, limit, scope }) => {
        const targetScope = scope === "sender" ? "sender" : "owner";
        const scopeJid =
          targetScope === "owner" ? this.ownJid || senderJid : senderJid;
        await this.memory.ensureReady();
        const items = await this.memory.retrieve(scopeJid, query, limit ?? 6);
        return {
          ok: true,
          message:
            items.length > 0
              ? `found ${items.length} memory item(s) for ${targetScope}`
              : `no memory matches for "${query}" in ${targetScope} scope`,
          data: {
            items: items.map((item) => ({
              fact: item.fact,
              confidence: item.confidence,
              source: item.source
            }))
          }
        };
      }
    };
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

  private async sendKlipyGifByQuery(args: {
    chatJid: string;
    query: string;
    customerId?: string;
    locale?: string;
    contentFilter?: "off" | "low" | "medium" | "high";
    perPage?: number;
  }): Promise<{
    ok: boolean;
    message: string;
    data?: {
      slug?: string;
      title?: string;
      query?: string;
      mediaUrl?: string;
      mediaFormat?: "mp4" | "gif" | "webm";
    };
  }> {
    if (!this.sock) {
      return { ok: false, message: "socket not ready" };
    }
    if (!this.klipy) {
      return { ok: false, message: "KLIPY app key missing (set KLIPY_APP_KEY or KLIPY_API_KEY)" };
    }

    const query = compactText(args.query);
    if (!query) {
      return { ok: false, message: "query is required" };
    }

    const customerId = toKlipyCustomerId(args.customerId ?? this.ownJid ?? args.chatJid);
    const locale = normalizeKlipyLocale(args.locale ?? this.env.klipyLocale);
    const contentFilter = args.contentFilter ?? this.env.klipyContentFilter;
    const perPage = clampInt(args.perPage ?? 8, 1, 20);

    try {
      const found = await this.klipy.searchGifs({
        query,
        customerId,
        locale,
        contentFilter,
        page: 1,
        perPage
      });

      const picked = found.picked;
      if (!picked) {
        return { ok: false, message: `no KLIPY GIF found for query: ${query}` };
      }

      const media = picked.mp4?.url
        ? { format: "mp4" as const, url: picked.mp4.url }
        : picked.webm?.url
        ? { format: "webm" as const, url: picked.webm.url }
        : picked.gif?.url
        ? { format: "gif" as const, url: picked.gif.url }
        : null;

      if (!media) {
        return { ok: false, message: `KLIPY result has no usable media for query: ${query}` };
      }

      if (media.format === "gif") {
        await this.sock.sendMessage(
          args.chatJid,
          {
            document: { url: media.url },
            fileName: `${picked.slug || "klipy"}.gif`,
            mimetype: "image/gif"
          },
          { useCachedGroupMetadata: false }
        );
      } else {
        await this.sock.sendMessage(
          args.chatJid,
          {
            video: { url: media.url },
            mimetype: media.format === "webm" ? "video/webm" : "video/mp4",
            gifPlayback: true
          },
          { useCachedGroupMetadata: false }
        );
      }

      this.logMinimalFlow(
        "ME",
        `${args.chatJid} | sent klipy gif: ${picked.title || picked.slug || "result"}`
      );

      return {
        ok: true,
        message: `sent KLIPY GIF for '${query}'`,
        data: {
          slug: picked.slug,
          title: picked.title,
          query,
          mediaUrl: media.url,
          mediaFormat: media.format
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `failed to send KLIPY GIF: ${message}` };
    }
  }

  private async sendVoiceReply(args: {
    chatJid: string;
    text: string;
    voice?: string;
    language?: string;
    speed?: number;
    speaker1Name?: string;
    speaker1Voice?: string;
    speaker2Name?: string;
    speaker2Voice?: string;
  }): Promise<{
    ok: boolean;
    message: string;
    data?: {
      provider?: string;
      voice?: string;
      language?: string;
      speed?: number;
      model?: string;
      multiSpeaker?: boolean;
    };
  }> {
    if (!this.sock) {
      return { ok: false, message: "socket not ready" };
    }

    const text = compactText(args.text).slice(0, 4_000);
    if (!text) {
      return { ok: false, message: "text is required" };
    }

    const language = normalizeTtsLanguage(args.language);
    const speed = clampFloat(args.speed ?? 1, 0.5, 1.6);
    const speaker1Name = compactText(args.speaker1Name ?? "");
    const speaker2Name = compactText(args.speaker2Name ?? "");
    const voice1 = normalizeGeminiTtsVoice(args.speaker1Voice ?? args.voice, "Kore");
    const voice2 = normalizeGeminiTtsVoice(args.speaker2Voice, "Puck");

    if (this.voicebox && !speaker1Name && !speaker2Name) {
      const viaVoicebox = await this.sendVoiceReplyViaVoicebox({
        chatJid: args.chatJid,
        text,
        language
      });
      if (viaVoicebox.ok) {
        return viaVoicebox;
      }
    }

    const multiSpeaker = Boolean(speaker1Name && speaker2Name);
    const prompt = multiSpeaker
      ? buildGeminiMultiSpeakerPrompt({
          script: text,
          speaker1Name,
          speaker2Name,
          language,
          speed
        })
      : buildGeminiSingleSpeakerPrompt({
          transcript: text,
          language,
          speed
        });

    const ttsModel = compactText(this.env.geminiTtsModel ?? "") || DEFAULT_GEMINI_TTS_MODEL;

    try {
      const speech = await this.gemini.generateSpeech({
        model: ttsModel,
        prompt,
        voiceName: voice1,
        speakers: multiSpeaker
          ? [
              { speaker: speaker1Name, voiceName: voice1 },
              { speaker: speaker2Name, voiceName: voice2 }
            ]
          : undefined
      });

      const preparedAudio = prepareGeminiTtsAudioForWhatsApp({
        data: speech.pcmData,
        mimeType: speech.mimeType,
        sampleRateHz: speech.sampleRateHz
      });

      const opusAudio =
        preparedAudio.format === "ogg_opus"
          ? preparedAudio.data
          : await transcodeAudioToOggOpus({
              data: preparedAudio.data,
              mimeType: preparedAudio.mimeType,
              sampleRateHz: speech.sampleRateHz
            });

      const outboundAudio = opusAudio
        ? {
            data: opusAudio,
            mimeType: "audio/ogg; codecs=opus",
            ptt: true,
            format: "ogg_opus"
          }
        : preparedAudio;

      const sentChatJid = await this.sendAudioMessageWithRetry({
        chatJid: args.chatJid,
        audio: outboundAudio.data,
        mimetype: outboundAudio.mimeType,
        ptt: outboundAudio.ptt
      });
      this.logMinimalFlow(
        "ME",
        `${sentChatJid} | sent voice reply (gemini_tts:${outboundAudio.format})`
      );

      const selectedVoice = multiSpeaker ? `${voice1},${voice2}` : voice1;
      return {
        ok: true,
        message: multiSpeaker
          ? "voice note sent via gemini_tts (multi-speaker)"
          : "voice note sent via gemini_tts",
        data: {
          provider: "gemini_tts",
          voice: selectedVoice,
          language,
          speed,
          model: speech.model,
          multiSpeaker
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `failed to send voice note: ${message}` };
    }
  }

  private async sendVoiceReplyViaVoicebox(args: {
    chatJid: string;
    text: string;
    language: string;
  }): Promise<{
    ok: boolean;
    message: string;
    data?: {
      provider?: string;
      voice?: string;
      language?: string;
      speed?: number;
      model?: string;
      multiSpeaker?: boolean;
    };
  }> {
    if (!this.voicebox) {
      return { ok: false, message: "voicebox not configured" };
    }

    const profileId = compactText(this.env.voiceboxProfileId ?? "");
    if (!profileId) {
      return { ok: false, message: "voicebox profile id missing" };
    }

    try {
      const healthy = await this.voicebox.checkHealth();
      if (!healthy) {
        return { ok: false, message: "voicebox health check failed" };
      }

      const generation = await this.voicebox.generate({
        profileId,
        text: args.text,
        language: compactText(this.env.voiceboxLanguage ?? "") || args.language,
        engine: compactText(this.env.voiceboxEngine ?? "") || undefined,
        modelSize: compactText(this.env.voiceboxModelSize ?? "") || undefined,
        normalize: true
      });

      const status = await this.voicebox.waitForCompletion({
        generationId: generation.generationId,
        pollIntervalMs: 1_500,
        maxWaitMs: 150_000
      });
      if (status.status !== "completed") {
        return {
          ok: false,
          message: status.error
            ? `voicebox generation failed: ${status.error}`
            : `voicebox generation failed with status=${status.status}`
        };
      }

      const wavAudio = await this.voicebox.downloadAudio(generation.generationId);
      if (!wavAudio || wavAudio.length === 0) {
        return { ok: false, message: "voicebox returned empty audio" };
      }

      const opusAudio = await transcodeAudioToOggOpus({
        data: wavAudio,
        mimeType: "audio/wav",
        sampleRateHz: 24_000
      });
      const outboundAudio = opusAudio
        ? {
            data: opusAudio,
            mimeType: "audio/ogg; codecs=opus",
            ptt: true
          }
        : {
            data: wavAudio,
            mimeType: "audio/wav",
            ptt: true
          };

      const sentChatJid = await this.sendAudioMessageWithRetry({
        chatJid: args.chatJid,
        audio: outboundAudio.data,
        mimetype: outboundAudio.mimeType,
        ptt: outboundAudio.ptt
      });
      this.logMinimalFlow("ME", `${sentChatJid} | sent voice reply (voicebox)`);

      return {
        ok: true,
        message: "voice note sent via voicebox",
        data: {
          provider: "voicebox",
          language: compactText(this.env.voiceboxLanguage ?? "") || args.language,
          model: compactText(this.env.voiceboxModelSize ?? "") || undefined,
          multiSpeaker: false
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `voicebox failed: ${message}` };
    }
  }

  private async sendAudioMessageWithRetry(args: {
    chatJid: string;
    audio: Buffer;
    mimetype: string;
    ptt: boolean;
  }): Promise<string> {
    if (!this.sock) throw new Error("socket not ready");

    const targets = buildMediaSendTargets(args.chatJid);
    let lastError: unknown;

    for (const targetJid of targets) {
      await this.warmSessionsForChat(targetJid);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await this.sock.sendMessage(
            targetJid,
            {
              audio: args.audio,
              mimetype: args.mimetype,
              ptt: args.ptt
            },
            { useCachedGroupMetadata: false }
          );
          return targetJid;
        } catch (error) {
          lastError = error;
          const errorName = (error as { name?: string } | undefined)?.name;
          const errData = (error as { data?: unknown } | undefined)?.data;
          const is406 =
            errData === 406 ||
            String((error as { message?: string } | undefined)?.message ?? "").includes(
              "not-acceptable"
            );
          if (errorName === "SessionError" || is406) {
            await this.warmSessionsForChat(targetJid);
          }
          if (attempt < 2) {
            await sleep(randomBetween(400, 900));
          }
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error("failed to send audio message");
  }

  private async sendImageReply(args: {
    chatJid: string;
    prompt: string;
    caption?: string;
    width?: number;
    height?: number;
    style?: "image" | "meme" | "quote_card";
  }): Promise<{
    ok: boolean;
    message: string;
    data?: { imageUrl?: string; prompt?: string; style?: string };
  }> {
    if (!this.sock) {
      return { ok: false, message: "socket not ready" };
    }

    const prompt = compactText(args.prompt).slice(0, 420);
    if (!prompt) {
      return { ok: false, message: "prompt is required" };
    }

    const width = clampInt(args.width ?? 1024, 512, 1536);
    const height = clampInt(args.height ?? 1024, 512, 1536);
    const style = args.style ?? "image";
    const imageUrl = buildPollinationsImageUrl({
      prompt,
      width,
      height,
      seed: Date.now(),
      style
    });

    const caption = compactText(args.caption ?? "") || defaultImageCaption(style, prompt);

    try {
      await this.sock.sendMessage(
        args.chatJid,
        {
          image: { url: imageUrl },
          caption
        },
        { useCachedGroupMetadata: false }
      );

      this.logMinimalFlow("ME", `${args.chatJid} | sent generated image (${style})`);
      return {
        ok: true,
        message: `image sent (${style})`,
        data: {
          imageUrl,
          prompt,
          style
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `failed to send image: ${message}` };
    }
  }

  private async sendToolTextMessage(args: {
    chatJid: string;
    text: string;
  }): Promise<void> {
    if (!this.sock) throw new Error("socket not ready");
    const text = compactText(args.text);
    if (!text) return;

    await this.sock.sendMessage(
      args.chatJid,
      { text },
      { useCachedGroupMetadata: false }
    );
    this.logMinimalFlow("ME", `${args.chatJid} | sent tool text`);
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
    const own = [
      this.ownJid,
      socketUserJid,
      this.ownLidHintJid,
      ...(this.config.selfSenderJids ?? [])
    ].filter(Boolean);
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

  private async handleSelfChatMessage(
    context: IncomingContext,
    incomingText: string,
    raw: BaileysMessage
  ): Promise<boolean> {
    try {
      this.logMinimalFlow(
        "USER",
        `self-chat | ${previewText(incomingText)}`,
        context.senderJid
      );
      this.aiStage("THINK", `self-chat intent for ${context.chatJid}`);
      const result = await this.selfChat.handle(incomingText, {
        chatJid: context.chatJid,
        senderJid: context.senderJid
      });
      this.aiStage("REPLY", `self-chat intent=${result.intent}`);
      if (result.replies.length > 0) {
        await this.sendReplies(context.chatJid, result.replies, raw, context.senderJid);
        this.sentCount += 1;
      } else {
        this.logger.info(
          { msgId: raw?.key?.id, chatJid: context.chatJid, intent: result.intent },
          "self-chat handled (tool sent message directly, no text follow-up)"
        );
      }
      appendDecisionLog(
        `${new Date().toISOString()} | chat=${context.chatJid} | sender=${context.senderJid} | decision=SELF_CHAT | intent=${result.intent}`
      );
      return true;
    } catch (error) {
      this.logger.warn({ err: stringifyErrorForLog(error) }, "self-chat handler failed");
      try {
        await this.sendReplies(
          context.chatJid,
          [`Self-chat error: ${stringifyErrorForLog(error)}`],
          raw,
          context.senderJid
        );
      } catch {
        // nothing we can do
      }
      return true;
    }
  }

  private resolveGroupLabel(jid: string): string {
    if (!jid) return jid;
    if (jid.endsWith("@g.us")) {
      const row = this.groupsCache.rows.find((r) => r.jid === jid);
      if (row && row.name) return row.name;
      const user = jid.split("@")[0] ?? jid;
      return `Group ${user.slice(-6)}`;
    }
    try {
      const storeContacts = this.sock?.store?.contacts as Record<string, unknown> | undefined;
      const entry = storeContacts?.[jid] as { name?: string; notify?: string } | undefined;
      return entry?.name || entry?.notify || (jid.split("@")[0] ?? jid);
    } catch {
      return jid.split("@")[0] ?? jid;
    }
  }

  private async resolveGroupJidByQuery(query: string): Promise<string | null> {
    const trimmed = query.trim();
    if (!trimmed) return null;
    if (trimmed.endsWith("@g.us") || trimmed.includes("@")) return trimmed;

    const groups = await this.getGroups();
    const needle = trimmed.toLowerCase();
    const matches = groups.filter((g) => (g.name ?? "").toLowerCase().includes(needle));
    if (matches.length === 0) return null;
    matches.sort((a, b) => (a.name ?? "").length - (b.name ?? "").length);
    return matches[0]?.jid ?? null;
  }

  private async sendProactiveText(targetJid: string, text: string): Promise<void> {
    if (!this.sock) return;
    const body = compactText(text);
    if (!body) return;
    try {
      await this.sock.sendPresenceUpdate("composing", targetJid);
      await sleep(randomBetween(400, 900));
      await this.sock.sendPresenceUpdate("paused", targetJid);
      await this.sock.sendMessage(targetJid, { text: body });
      this.rememberOutgoing(targetJid, body);
      const out: MessageRecord = {
        chatJid: targetJid,
        senderJid: this.ownJid || "me",
        timestampISO: new Date().toISOString(),
        role: "outgoing",
        text: body
      };
      appendChatHistory(out);
    } catch (error) {
      this.logger.warn({ err: stringifyErrorForLog(error), targetJid }, "proactive send failed");
      throw error;
    }
  }
}

function stringifyErrorForLog(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
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

function normalizeGeminiInlineMimeType(mimeType: string): string {
  const raw = compactText(mimeType).toLowerCase();
  if (!raw) return "application/octet-stream";
  const base = raw.split(";")[0]?.trim() ?? raw;
  if (!base) return "application/octet-stream";
  if (base === "audio/opus") return "audio/ogg";
  return base;
}

function isExplicitVoiceToolIntent(input: string): boolean {
  const text = compactText(input).toLowerCase();
  if (!text) return false;

  if (text.includes("send_voice_reply") || text.includes("end_voice_reply")) {
    return true;
  }

  return (
    /voice\s*(msg|message|note)/.test(text) ||
    /voice\s*reply/.test(text) ||
    /tool\s*call.*voice/.test(text) ||
    /voice.*tool\s*call/.test(text)
  );
}

function defaultExplicitVoiceReplyText(): string {
  return "Ami voice-e reply dicchi, bolo ki niye kotha bolbo.";
}

function buildMediaSendTargets(chatJid: string): string[] {
  const targets = new Set<string>();
  targets.add(chatJid);

  if (chatJid.endsWith("@g.us")) {
    return [...targets];
  }

  const user = compactText(chatJid.split("@")[0] ?? "");
  if (!user) {
    return [...targets];
  }

  if (chatJid.endsWith("@lid")) {
    targets.add(`${user}@s.whatsapp.net`);
  } else if (chatJid.endsWith("@s.whatsapp.net")) {
    targets.add(`${user}@lid`);
  }

  return [...targets];
}

function parseTextToolCalls(
  text: string
): Array<{ id?: string; name: string; args: Record<string, unknown> }> {
  if (!text) return [];

  const allowedNames = new Set([
    "list_available_tools",
    "list_local_files",
    "read_local_file",
    "share_local_file",
    "send_sticker",
    "send_gif",
    "send_klipy_gif",
    "send_voice_reply",
    "end_voice_reply",
    "send_image_reply",
    "send_meme_reply",
    "send_styled_quote_card",
    "send_voice_plus_text",
    "send_reaction_combo"
  ]);

  const calls: Array<{ id?: string; name: string; args: Record<string, unknown> }> = [];
  const pattern =
    /(?:default_api\.)?(list_available_tools|list_local_files|read_local_file|share_local_file|send_sticker|send_gif|send_klipy_gif|send_voice_reply|end_voice_reply|send_image_reply|send_meme_reply|send_styled_quote_card|send_voice_plus_text|send_reaction_combo)\s*\(([^)]*)\)/gim;

  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(text)) !== null) {
    const name = compactText(match[1] ?? "");
    if (!name || !allowedNames.has(name)) continue;
    const rawArgs = match[2] ?? "";
    calls.push({
      name,
      args: parseTextToolArgs(rawArgs)
    });
  }

  return calls;
}

function parseTextToolArgs(raw: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const input = compactText(raw);
  if (!input) return args;

  const keyValuePattern =
    /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*('(?:\\'|[^'])*'|"(?:\\"|[^"])*"|`(?:\\`|[^`])*`|[^,]+)(?:,|$)/g;

  let match: RegExpExecArray | null = null;
  while ((match = keyValuePattern.exec(raw)) !== null) {
    const key = compactText(match[1] ?? "");
    const valueRaw = compactText(match[2] ?? "");
    if (!key) continue;
    args[key] = parseTextToolArgValue(valueRaw);
  }

  if (Object.keys(args).length === 0 && input) {
    args.path = parseTextToolArgValue(input);
  }

  return args;
}

function parseTextToolArgValue(raw: string): unknown {
  const value = compactText(raw);
  if (!value) return "";

  const wrappedSingle = value.startsWith("'") && value.endsWith("'");
  const wrappedDouble = value.startsWith('"') && value.endsWith('"');
  const wrappedBacktick = value.startsWith("`") && value.endsWith("`");
  if (wrappedSingle || wrappedDouble || wrappedBacktick) {
    return value.slice(1, -1);
  }

  const lowered = value.toLowerCase();
  if (lowered === "true") return true;
  if (lowered === "false") return false;
  if (lowered === "null") return null;

  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) return asNumber;

  return value;
}

function stripParsedToolCallText(text: string): string {
  if (!text) return "";
  // Strip call-style: send_gif(query='...') or default_api.send_gif(...)
  let result = text.replace(
    /`?\s*(?:default_api\.)?(list_available_tools|list_local_files|read_local_file|share_local_file|send_sticker|send_gif|send_klipy_gif|send_voice_reply|end_voice_reply|send_image_reply|send_meme_reply|send_styled_quote_card|send_voice_plus_text|send_reaction_combo)\s*\([^`)]*\)\s*`?/gim,
    " "
  );
  // Strip ```tool_outputs {...}``` blocks that the model sometimes emits in text
  result = result.replace(/```tool_outputs[\s\S]*?```/gi, " ");
  // Strip any remaining fenced code block that contains only JSON/dict-like content (tool result blobs)
  result = result.replace(/```[a-z_]*\s*\{[\s\S]*?\}\s*```/gi, " ");
  return compactText(result);
}

function extractNarratedGifQuery(replyText: string, fallbackContext: string): string {
  const text = compactText(replyText).toLowerCase();
  if (!text) return "";

  const hasGifWord = /\bgif\b|giphy|tenor|klipy/.test(text);
  if (!hasGifWord) return "";

  const hasSendIntent =
    /(send|sending|patha|pathao|pathachi|pathachchi|pathabo|pathaun|bhej|share)/.test(text) ||
    /(?:i|ami|main)\s+(?:will|can|gonna)\s+send/.test(text);
  if (!hasSendIntent) return "";

  const fromQuoted = replyText.match(/["'`]{1}([^"'`]{2,80})["'`]{1}/);
  if (fromQuoted?.[1]) {
    return deriveGifQuery(fromQuoted[1]);
  }

  const fallback = compactText(fallbackContext);
  if (fallback) {
    return deriveGifQuery(fallback);
  }

  return "reaction gif";
}

function deriveGifQuery(source: string): string {
  const normalized = compactText(source).toLowerCase();
  if (!normalized) return "reaction gif";
  return normalized
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join(" ");
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clampFloat(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function normalizeTtsLanguage(value: string | undefined): string {
  const compact = compactText(value ?? "").toLowerCase();
  if (!compact) return "en";
  if (/^[a-z]{2}$/.test(compact)) return compact;
  if (/^[a-z]{2}[-_][a-z]{2}$/.test(compact)) {
    return compact.replace("_", "-");
  }
  return "en";
}

function normalizeGeminiTtsVoice(value: string | undefined, fallback: string): string {
  const compact = compactText(value ?? "").toLowerCase();
  if (compact) {
    const matched = GEMINI_TTS_VOICE_LOOKUP.get(compact);
    if (matched) return matched;
  }

  const fallbackMatched = GEMINI_TTS_VOICE_LOOKUP.get(fallback.toLowerCase());
  return fallbackMatched ?? "Kore";
}

function buildGeminiSingleSpeakerPrompt(args: {
  transcript: string;
  language: string;
  speed: number;
}): string {
  return [
    "Read the transcript exactly as written. Do not add extra words or headings.",
    `Language: ${args.language}.`,
    `Pacing: ${toPacingInstruction(args.speed)}.`,
    "Style: expressive, natural, and conversational.",
    "TRANSCRIPT:",
    args.transcript
  ].join("\n");
}

function buildGeminiMultiSpeakerPrompt(args: {
  script: string;
  speaker1Name: string;
  speaker2Name: string;
  language: string;
  speed: number;
}): string {
  const script = ensureSpeakerScript(args.script, args.speaker1Name, args.speaker2Name);
  return [
    "Generate two-speaker TTS dialogue exactly from the transcript.",
    `Speakers are ${args.speaker1Name} and ${args.speaker2Name}.`,
    `Language: ${args.language}.`,
    `Pacing: ${toPacingInstruction(args.speed)}.`,
    "Do not add any narration or extra lines.",
    "TRANSCRIPT:",
    script
  ].join("\n");
}

function toPacingInstruction(speed: number): string {
  if (speed <= 0.8) return "slow and calm with clear pauses";
  if (speed >= 1.3) return "fast and energetic but still intelligible";
  return "natural conversational pace";
}

function ensureSpeakerScript(script: string, speaker1Name: string, speaker2Name: string): string {
  const compact = compactText(script);
  const speaker1Pattern = new RegExp(`\\b${escapeRegExp(speaker1Name)}\\s*:`, "i");
  const speaker2Pattern = new RegExp(`\\b${escapeRegExp(speaker2Name)}\\s*:`, "i");
  if (speaker1Pattern.test(compact) && speaker2Pattern.test(compact)) {
    return compact;
  }

  const turns = compact
    .split(/(?<=[.!?])\s+/)
    .map((segment) => compactText(segment))
    .filter(Boolean)
    .slice(0, 10);

  if (turns.length === 0) {
    return `${speaker1Name}: ${compact}`;
  }

  return turns
    .map((turn, index) => `${index % 2 === 0 ? speaker1Name : speaker2Name}: ${turn}`)
    .join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wrapPcm16LeAsWav(pcmData: Buffer, sampleRateHz: number): Buffer {
  const safeRate = clampInt(sampleRateHz, 8_000, 96_000);
  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = safeRate * blockAlign;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcmData.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(safeRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcmData.length, 40);

  return Buffer.concat([header, pcmData]);
}

function prepareGeminiTtsAudioForWhatsApp(args: {
  data: Buffer;
  mimeType: string;
  sampleRateHz: number;
}): {
  data: Buffer;
  mimeType: string;
  ptt: boolean;
  format: "ogg_opus" | "wav" | "pcm_to_wav" | "audio_generic";
} {
  const normalizedMime = compactText(args.mimeType).toLowerCase();
  const baseMime = normalizedMime.split(";")[0]?.trim() || normalizedMime;

  if (
    normalizedMime.includes("audio/ogg") ||
    normalizedMime.includes("audio/opus") ||
    normalizedMime.includes("codecs=opus")
  ) {
    return {
      data: args.data,
      mimeType: "audio/ogg; codecs=opus",
      ptt: true,
      format: "ogg_opus"
    };
  }

  if (
    baseMime === "audio/wav" ||
    baseMime === "audio/x-wav" ||
    baseMime === "audio/wave"
  ) {
    return {
      data: args.data,
      mimeType: "audio/wav",
      ptt: false,
      format: "wav"
    };
  }

  if (
    normalizedMime.includes("audio/pcm") ||
    normalizedMime.includes("audio/l16") ||
    normalizedMime.includes("audio/raw") ||
    normalizedMime.includes("rate=")
  ) {
    return {
      data: wrapPcm16LeAsWav(args.data, args.sampleRateHz),
      mimeType: "audio/wav",
      ptt: false,
      format: "pcm_to_wav"
    };
  }

  if (baseMime.startsWith("audio/")) {
    return {
      data: args.data,
      mimeType: baseMime,
      ptt: false,
      format: "audio_generic"
    };
  }

  return {
    data: wrapPcm16LeAsWav(args.data, args.sampleRateHz),
    mimeType: "audio/wav",
    ptt: false,
    format: "pcm_to_wav"
  };
}

async function transcodeAudioToOggOpus(args: {
  data: Buffer;
  mimeType: string;
  sampleRateHz: number;
}): Promise<Buffer | null> {
  const normalizedMime = compactText(args.mimeType).toLowerCase();
  const baseMime = normalizedMime.split(";")[0]?.trim() || normalizedMime;

  const wavInput =
    baseMime === "audio/wav" || baseMime === "audio/x-wav" || baseMime === "audio/wave"
      ? args.data
      : wrapPcm16LeAsWav(args.data, args.sampleRateHz);

  ensureTtsTempDir();
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const inPath = path.join(TTS_TMP_DIR, `in-${token}.wav`);
  const outPath = path.join(TTS_TMP_DIR, `out-${token}.ogg`);

  try {
    writeFileSync(inPath, wavInput);
    const ok = await runFfmpegOpusTranscode(inPath, outPath);
    if (!ok || !existsSync(outPath)) return null;
    const ogg = readFileSync(outPath);
    if (!ogg || ogg.length === 0) return null;
    return ogg;
  } catch {
    return null;
  } finally {
    safeRemoveFile(inPath);
    safeRemoveFile(outPath);
  }
}

function ensureTtsTempDir(): void {
  if (!existsSync(TTS_TMP_DIR)) {
    mkdirSync(TTS_TMP_DIR, { recursive: true });
  }
}

function runFfmpegOpusTranscode(inputWavPath: string, outputOggPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        inputWavPath,
        "-c:a",
        "libopus",
        "-b:a",
        "32k",
        "-vbr",
        "on",
        "-compression_level",
        "10",
        "-application",
        "voip",
        outputOggPath
      ],
      { windowsHide: true }
    );

    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

function safeRemoveFile(filePath: string): void {
  try {
    rmSync(filePath, { force: true });
  } catch {
    // ignore best-effort temp cleanup failures
  }
}

function stylePromptForImage(
  prompt: string,
  style: "image" | "meme" | "quote_card"
): string {
  const base = compactText(prompt);
  if (style === "meme") {
    return `${base}. Meme-style visual, expressive composition, internet-culture energy, bold readable layout.`;
  }
  if (style === "quote_card") {
    return `${base}. Premium quote-card design, elegant typography, soft gradient background, highly readable text layout.`;
  }
  return `${base}. Photorealistic or high-quality digital art, clean composition, rich detail.`;
}

function buildPollinationsImageUrl(args: {
  prompt: string;
  width: number;
  height: number;
  seed: number;
  style: "image" | "meme" | "quote_card";
}): string {
  const prompt = stylePromptForImage(args.prompt, args.style);
  const width = clampInt(args.width, 512, 1536);
  const height = clampInt(args.height, 512, 1536);
  const seed = clampInt(args.seed, 1, 2147483647);
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${width}&height=${height}&seed=${seed}&model=flux&nologo=true`;
}

function defaultImageCaption(
  style: "image" | "meme" | "quote_card",
  prompt: string
): string {
  const short = previewText(prompt, 72);
  if (style === "meme") return `meme drop: ${short}`;
  if (style === "quote_card") return "styled quote card";
  return `image: ${short}`;
}

function toKlipyCustomerId(value: string): string {
  const compact = compactText(value || "");
  const userPart = compact.split("@")[0]?.split(":")[0] ?? compact;
  const sanitized = userPart.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
  return sanitized || "talky_user";
}

function normalizeKlipyLocale(value: string | undefined): string | undefined {
  const compact = compactText(value ?? "").toLowerCase();
  if (/^[a-z]{2}$/.test(compact)) return compact;
  const localeMatch = compact.match(/^[a-z]{2}_[a-z]{2}$/);
  if (localeMatch) {
    const country = compact.split("_")[1];
    if (country && /^[a-z]{2}$/.test(country)) return country;
  }
  return undefined;
}

function isToolListIntent(input: string): boolean {
  const text = compactText(input).toLowerCase();
  if (!text) return false;

  const keywords = [
    "tool list",
    "list tools",
    "available tools",
    "what tools",
    "ki ki tool",
    "tool call korte",
    "tool call list",
    "registry"
  ];

  return keywords.some((keyword) => text.includes(keyword));
}

function inferMemoryFact(text: string): string | null {
  if (!text) return null;
  if (text.length > 220) return null;
  const low = text.toLowerCase();
  const personalCue = low.includes("i ") || low.includes("my ") || low.includes("i'm ");
  const imperativeCue =
    /\b(remember|dont forget|don't forget|note that|keep in mind|remind me|save this)\b/i.test(
      text
    );
  const scheduleCue =
    /\b(meeting|meet|call|appointment|appt|deadline|due|flight|interview|class|exam|party|dinner|lunch)\b/i.test(
      text
    ) && /\b(at|on|by|tomorrow|tonight|today|am|pm|\d{1,2}(:\d{2})?)\b/i.test(text);
  if (!personalCue && !imperativeCue && !scheduleCue) return null;
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

function isGroupJidAllowed(chatJid: string, allowedGroupJids: string[]): boolean {
  const needle = chatJid.trim().toLowerCase();
  return allowedGroupJids.some((g) => g.trim().toLowerCase() === needle);
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
  const { jid } = normalizeJidInput(input);
  return jid;
}

// WAMessage.messageTimestamp is either a number (seconds) or a protobuf Long.
// Returns unix seconds or null when the value is missing/unparseable.
function extractMessageTimestampSeconds(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.floor(parsed) : null;
  }
  if (typeof value === "object") {
    const maybe = value as { toNumber?: () => number; low?: number; high?: number };
    if (typeof maybe.toNumber === "function") {
      const n = maybe.toNumber();
      return Number.isFinite(n) ? Math.floor(n) : null;
    }
    if (typeof maybe.low === "number") return Math.floor(maybe.low);
  }
  return null;
}

export type ContactResolution = {
  input: string;
  phoneJid: string | null;
  lidJid: string | null;
  exists: boolean;
  warnings: string[];
};

export async function resolveContactJid(input: string): Promise<ContactResolution> {
  const warnings: string[] = [];
  const parsed = normalizeJidInput(input);

  if (parsed.kind === "group" || parsed.kind === "broadcast") {
    throw new Error(`contact:resolve expects a user JID/phone, got ${parsed.kind}: ${input}`);
  }

  const initialPhoneJid = parsed.kind === "phone" ? parsed.jid : null;
  const initialLidJid = parsed.kind === "lid" ? parsed.jid : null;

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

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("connection timeout — is wa_auth valid? try `bun run start` once first"));
      }, 30_000);
      sock.ev.on("connection.update", (update: any) => {
        if (update?.qr) {
          clearTimeout(timer);
          reject(new Error("no active session — run `bun run start` and scan the QR first"));
        }
        if (update?.connection === "open") {
          clearTimeout(timer);
          resolve();
        }
        if (update?.connection === "close") {
          const code = update?.lastDisconnect?.error?.output?.statusCode;
          if (code === DisconnectReason.loggedOut) {
            clearTimeout(timer);
            reject(new Error("logged out — run `bun run relink` for a fresh QR"));
          }
        }
      });
    });

    let phoneJid = initialPhoneJid;
    let exists = false;
    if (parsed.kind === "phone" || (parsed.kind === "lid" && /^\d+$/.test(parsed.digits))) {
      const lookupDigits = parsed.digits;
      try {
        const results = await sock.onWhatsApp(lookupDigits);
        const match = results?.find((entry: any) => entry?.exists);
        if (match) {
          phoneJid = match.jid ?? `${lookupDigits}@s.whatsapp.net`;
          exists = true;
        } else {
          warnings.push(`WhatsApp says this number is not registered: ${lookupDigits}`);
          phoneJid = phoneJid ?? `${lookupDigits}@s.whatsapp.net`;
        }
      } catch (error) {
        warnings.push(
          `onWhatsApp lookup failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    let lidJid = initialLidJid;
    if (!lidJid && phoneJid) {
      try {
        const lidStore = (sock as any).signalRepository?.lidMapping;
        if (lidStore?.getLIDForPN) {
          const lid = await lidStore.getLIDForPN(phoneJid);
          if (typeof lid === "string" && lid) {
            lidJid = lid.split(":")[0].endsWith("@lid") ? lid.split(":")[0] : lid;
          } else {
            warnings.push("no @lid mapping cached yet — exchange at least one message with this contact first");
          }
        }
      } catch (error) {
        warnings.push(
          `LID lookup failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return {
      input,
      phoneJid,
      lidJid,
      exists,
      warnings
    };
  } finally {
    try {
      sock.ev.removeAllListeners("connection.update");
      sock.end(undefined as any);
    } catch {
      // ignore
    }
  }
}
