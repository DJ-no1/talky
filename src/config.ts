import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import YAML from "yaml";
import type { AppConfig, AppEnv } from "./types";

export const ROOT_DIR = process.cwd();
export const DATA_DIR = path.join(ROOT_DIR, "data");
export const CHAT_DIR = path.join(DATA_DIR, "chats");
export const LOG_DIR = path.join(DATA_DIR, "logs");
export const MEMORY_DIR = path.join(DATA_DIR, "memory");
export const STICKER_PACK_DIR = path.join(DATA_DIR, "stickers");
export const TOOL_ACTION_LOG_PATH = path.join(LOG_DIR, "tool-actions.md");
export const AUTH_DIR = path.join(ROOT_DIR, "wa_auth");
export const CONFIG_PATH = path.join(ROOT_DIR, "config.yaml");
export const WA_LOCK_PATH = path.join(DATA_DIR, "wa-session.lock");
export const PERSONA_DIR = path.join(ROOT_DIR, "persona");
export const PERSONA_CONTACTS_DIR = path.join(PERSONA_DIR, "contacts");
export const PERSONA_GROUPS_DIR = path.join(PERSONA_DIR, "groups");

const desktopRoot = process.env.USERPROFILE
  ? path.join(process.env.USERPROFILE, "Desktop")
  : ROOT_DIR;

const defaultConfig: AppConfig = {
  botName: "talky",
  model: "gemini-2.0-flash",
  runtimeLogMode: "minimal",
  replyOnlyOnMention: false,
  askBeforeReply: false,
  alwaysReplyInAllowedGroups: false,
  directChatMode: "allowlist",
  appendHistoryForDisallowedChats: false,
  recordManualOutboundMessages: true,
  selfSenderJids: [],
  proactiveOnStartupEnabled: false,
  proactiveOnStartupDirectJids: [],
  allowedGroupJids: [],
  mutedGroupJids: [],
  allowedDirectJids: [],
  selfChatEnabled: false,
  historyWindow: 15,
  senderHistoryWindow: 5,
  selfHistoryWindow: 3,
  memoryTopK: 5,
  minReplyDelayMs: 2_000,
  maxReplyDelayMs: 5_000,
  dailyMessageLimit: 200,
  maxInputMediaBytes: 6_000_000,
  toolCallingEnabled: true,
  toolLoopMaxSteps: 8,
  maxToolReadFileBytes: 2_000_000,
  maxShareFileBytes: 150_000_000,
  localFileAllowedRoots: [desktopRoot],
  localFileBlockedExtensions: [
    ".exe",
    ".dll",
    ".bat",
    ".cmd",
    ".ps1",
    ".sh",
    ".msi",
    ".com",
    ".scr"
  ],
  localFileBlockedPathFragments: ["/.git/", "/node_modules/", "/wa_auth/",'/.env'],
  allowShareToAllowedGroups: true,
  stickerPackDir: STICKER_PACK_DIR,
  allowForwardIncomingStickers: true,
  stickerReplyMode: "always-sticker",
  selfChatDigestHour: 9,
  selfChatDigestEnabled: true,
  selfChatReminderPollSeconds: 30,
  memoryBackend: "hybrid",
  memoryEmbeddingsEnabled: true,
  memoryConsolidationHours: 6,
  startupGraceSeconds: 20,
  staleMessageMaxAgeSeconds: 120
};

export function ensureRuntimeDirs(): void {
  for (const folder of [
    DATA_DIR,
    CHAT_DIR,
    LOG_DIR,
    MEMORY_DIR,
    STICKER_PACK_DIR,
    AUTH_DIR,
    PERSONA_DIR,
    PERSONA_CONTACTS_DIR,
    PERSONA_GROUPS_DIR
  ]) {
    if (!existsSync(folder)) {
      mkdirSync(folder, { recursive: true });
    }
  }
}

export function loadEnv(): AppEnv {
  dotenv.config();
  const geminiApiKey =
    process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "";
  const geminiTtsModel = compactOptional(
    process.env.GEMINI_TTS_MODEL ?? process.env.google_gemini_tts_model
  );
  const mem0ApiKey =
    process.env.MEM0_API_KEY ?? process.env.memo_api_key ?? process.env.MEMO_API_KEY;
  const klipyAppKey =
    process.env.KLIPY_APP_KEY ??
    process.env.KLIPY_API_KEY ??
    process.env.klipy_app_key ??
    process.env.klipy_api_key;
  const klipyLocale =
    process.env.KLIPY_LOCALE ??
    process.env.KLIPY_COUNTRY_CODE ??
    process.env.klipy_locale ??
    process.env.klipy_country_code;
  const rawKlipyContentFilter = compactOptional(
    process.env.KLIPY_CONTENT_FILTER ?? process.env.klipy_content_filter
  )?.toLowerCase();
  const klipyContentFilter =
    rawKlipyContentFilter === "off" ||
    rawKlipyContentFilter === "low" ||
    rawKlipyContentFilter === "medium" ||
    rawKlipyContentFilter === "high"
      ? rawKlipyContentFilter
      : undefined;
  const voiceboxBaseUrl = compactOptional(
    process.env.VOICEBOX_BASE_URL ?? process.env.voicebox_base_url
  );
  const voiceboxProfileId = compactOptional(
    process.env.VOICEBOX_PROFILE_ID ?? process.env.voicebox_profile_id
  );
  const voiceboxLanguage = compactOptional(
    process.env.VOICEBOX_LANGUAGE ?? process.env.voicebox_language
  );
  const voiceboxEngine = compactOptional(
    process.env.VOICEBOX_ENGINE ?? process.env.voicebox_engine
  );
  const voiceboxModelSize = compactOptional(
    process.env.VOICEBOX_MODEL_SIZE ?? process.env.voicebox_model_size
  );

  if (!geminiApiKey) {
    throw new Error(
      "Gemini API key missing. Set GEMINI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY in .env"
    );
  }

  return {
    geminiApiKey,
    geminiTtsModel,
    mem0ApiKey,
    klipyAppKey,
    klipyLocale,
    klipyContentFilter,
    voiceboxBaseUrl,
    voiceboxProfileId,
    voiceboxLanguage,
    voiceboxEngine,
    voiceboxModelSize
  };
}

export function writeDefaultConfig(): AppConfig {
  ensureRuntimeDirs();
  writeFileSync(CONFIG_PATH, YAML.stringify(defaultConfig), "utf-8");
  return defaultConfig;
}

export function loadConfig(): AppConfig {
  ensureRuntimeDirs();
  if (!existsSync(CONFIG_PATH)) {
    return writeDefaultConfig();
  }

  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const parsed = YAML.parse(raw) as Partial<AppConfig> | undefined;
  return {
    ...defaultConfig,
    ...(parsed ?? {}),
    runtimeLogMode:
      parsed?.runtimeLogMode === "verbose" || parsed?.runtimeLogMode === "minimal"
        ? parsed.runtimeLogMode
        : defaultConfig.runtimeLogMode,
    alwaysReplyInAllowedGroups:
      typeof parsed?.alwaysReplyInAllowedGroups === "boolean"
        ? parsed.alwaysReplyInAllowedGroups
        : defaultConfig.alwaysReplyInAllowedGroups,
    directChatMode:
      parsed?.directChatMode === "all" ||
      parsed?.directChatMode === "none" ||
      parsed?.directChatMode === "allowlist"
        ? parsed.directChatMode
        : defaultConfig.directChatMode,
    appendHistoryForDisallowedChats:
      typeof parsed?.appendHistoryForDisallowedChats === "boolean"
        ? parsed.appendHistoryForDisallowedChats
        : defaultConfig.appendHistoryForDisallowedChats,
    recordManualOutboundMessages:
      typeof parsed?.recordManualOutboundMessages === "boolean"
        ? parsed.recordManualOutboundMessages
        : defaultConfig.recordManualOutboundMessages,
    proactiveOnStartupEnabled:
      typeof parsed?.proactiveOnStartupEnabled === "boolean"
        ? parsed.proactiveOnStartupEnabled
        : defaultConfig.proactiveOnStartupEnabled,
    proactiveOnStartupDirectJids:
      parsed?.proactiveOnStartupDirectJids ?? defaultConfig.proactiveOnStartupDirectJids,
    selfSenderJids: parsed?.selfSenderJids ?? defaultConfig.selfSenderJids,
    allowedGroupJids: parsed?.allowedGroupJids ?? defaultConfig.allowedGroupJids,
    mutedGroupJids: parsed?.mutedGroupJids ?? defaultConfig.mutedGroupJids,
    allowedDirectJids: parsed?.allowedDirectJids ?? defaultConfig.allowedDirectJids,
    selfChatEnabled:
      typeof parsed?.selfChatEnabled === "boolean"
        ? parsed.selfChatEnabled
        : defaultConfig.selfChatEnabled,
    senderHistoryWindow: parsed?.senderHistoryWindow ?? defaultConfig.senderHistoryWindow,
    selfHistoryWindow: parsed?.selfHistoryWindow ?? defaultConfig.selfHistoryWindow,
    toolCallingEnabled:
      typeof parsed?.toolCallingEnabled === "boolean"
        ? parsed.toolCallingEnabled
        : defaultConfig.toolCallingEnabled,
    toolLoopMaxSteps: asBoundedPositiveInt(
      parsed?.toolLoopMaxSteps,
      defaultConfig.toolLoopMaxSteps,
      1,
      8
    ),
    maxToolReadFileBytes: asBoundedPositiveInt(
      parsed?.maxToolReadFileBytes,
      defaultConfig.maxToolReadFileBytes,
      16_384,
      20_000_000
    ),
    maxShareFileBytes: asBoundedPositiveInt(
      parsed?.maxShareFileBytes,
      defaultConfig.maxShareFileBytes,
      1_000_000,
      150_000_000
    ),
    localFileAllowedRoots: nonEmptyStringArray(
      parsed?.localFileAllowedRoots,
      defaultConfig.localFileAllowedRoots
    ),
    localFileBlockedExtensions: nonEmptyStringArray(
      parsed?.localFileBlockedExtensions,
      defaultConfig.localFileBlockedExtensions
    ).map((ext) => normalizeExtension(ext)),
    localFileBlockedPathFragments: nonEmptyStringArray(
      parsed?.localFileBlockedPathFragments,
      defaultConfig.localFileBlockedPathFragments
    ),
    allowShareToAllowedGroups:
      typeof parsed?.allowShareToAllowedGroups === "boolean"
        ? parsed.allowShareToAllowedGroups
        : defaultConfig.allowShareToAllowedGroups,
    stickerPackDir:
      typeof parsed?.stickerPackDir === "string" && parsed.stickerPackDir.trim().length > 0
        ? parsed.stickerPackDir.trim()
        : defaultConfig.stickerPackDir,
    allowForwardIncomingStickers:
      typeof parsed?.allowForwardIncomingStickers === "boolean"
        ? parsed.allowForwardIncomingStickers
        : defaultConfig.allowForwardIncomingStickers,
    stickerReplyMode:
      parsed?.stickerReplyMode === "model" ||
      parsed?.stickerReplyMode === "always-sticker" ||
      parsed?.stickerReplyMode === "explicit-only"
        ? parsed.stickerReplyMode
        : defaultConfig.stickerReplyMode,
    selfChatDigestHour: asBoundedPositiveInt(
      parsed?.selfChatDigestHour,
      defaultConfig.selfChatDigestHour,
      0,
      23
    ),
    selfChatDigestEnabled:
      typeof parsed?.selfChatDigestEnabled === "boolean"
        ? parsed.selfChatDigestEnabled
        : defaultConfig.selfChatDigestEnabled,
    selfChatReminderPollSeconds: asBoundedPositiveInt(
      parsed?.selfChatReminderPollSeconds,
      defaultConfig.selfChatReminderPollSeconds,
      10,
      600
    ),
    memoryBackend:
      parsed?.memoryBackend === "legacy" || parsed?.memoryBackend === "hybrid"
        ? parsed.memoryBackend
        : defaultConfig.memoryBackend,
    memoryEmbeddingsEnabled:
      typeof parsed?.memoryEmbeddingsEnabled === "boolean"
        ? parsed.memoryEmbeddingsEnabled
        : defaultConfig.memoryEmbeddingsEnabled,
    memoryConsolidationHours: asBoundedPositiveInt(
      parsed?.memoryConsolidationHours,
      defaultConfig.memoryConsolidationHours,
      1,
      168
    ),
    startupGraceSeconds: asBoundedNonNegativeInt(
      parsed?.startupGraceSeconds,
      defaultConfig.startupGraceSeconds,
      0,
      600
    ),
    staleMessageMaxAgeSeconds: asBoundedNonNegativeInt(
      parsed?.staleMessageMaxAgeSeconds,
      defaultConfig.staleMessageMaxAgeSeconds,
      0,
      86_400
    )
  };
}

export function saveConfig(config: AppConfig): void {
  writeFileSync(CONFIG_PATH, YAML.stringify(config), "utf-8");
}

export function resetWhatsAppAuth(): void {
  if (existsSync(AUTH_DIR)) {
    rmSync(AUTH_DIR, { recursive: true, force: true });
  }
  mkdirSync(AUTH_DIR, { recursive: true });
}

/**
 * Factory reset local Talky runtime state (auth, chats, logs, memory, persona, config).
 * Keeps source code and .env files untouched.
 */
export function resetTalkyRuntimeState(): void {
  const resetTargets = [AUTH_DIR, DATA_DIR, PERSONA_DIR];
  for (const target of resetTargets) {
    removePathWithRetries(target, { recursive: true, force: true });
  }

  removePathWithRetries(CONFIG_PATH, { force: true });

  ensureRuntimeDirs();
  writeDefaultConfig();
}

function removePathWithRetries(
  target: string,
  options: { recursive?: boolean; force?: boolean }
): void {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (!existsSync(target)) return;
      rmSync(target, options);
      return;
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code ?? "")
          : "";
      const retriable = code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY";
      if (!retriable || attempt === maxAttempts) {
        throw error;
      }
      // Brief backoff for Windows file-handle release.
      Bun.sleepSync(120 * attempt);
    }
  }
}

export function repairWhatsAppSessionState(): { deleted: number; deletedFiles: string[] } {
  ensureRuntimeDirs();
  if (!existsSync(AUTH_DIR)) {
    mkdirSync(AUTH_DIR, { recursive: true });
    return { deleted: 0, deletedFiles: [] };
  }

  const removablePrefixes = [
    "session-",
    "sender-key-",
    "app-state-sync-key-",
    "lid-mapping-",
    "device-list-",
    "pre-key-"
  ];
  const keepNames = new Set(["creds.json", "app-state-sync-version-critical_block.json"]);
  const deletedFiles: string[] = [];

  for (const name of readdirSync(AUTH_DIR)) {
    if (keepNames.has(name)) continue;
    if (!removablePrefixes.some((prefix) => name.startsWith(prefix))) continue;
    const filePath = path.join(AUTH_DIR, name);
    rmSync(filePath, { force: true });
    deletedFiles.push(name);
  }

  return { deleted: deletedFiles.length, deletedFiles };
}

function nonEmptyStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const cleaned = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return cleaned.length > 0 ? cleaned : fallback;
}

function asBoundedPositiveInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function asBoundedNonNegativeInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  const clamped = Math.min(max, Math.max(min, Math.floor(value)));
  return clamped;
}

function normalizeExtension(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "";
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function compactOptional(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
