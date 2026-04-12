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
export const AUTH_DIR = path.join(ROOT_DIR, "wa_auth");
export const CONFIG_PATH = path.join(ROOT_DIR, "config.yaml");
export const WA_LOCK_PATH = path.join(DATA_DIR, "wa-session.lock");
export const PERSONA_DIR = path.join(ROOT_DIR, "persona");
export const PERSONA_CONTACTS_DIR = path.join(PERSONA_DIR, "contacts");
export const PERSONA_GROUPS_DIR = path.join(PERSONA_DIR, "groups");

const defaultConfig: AppConfig = {
  botName: "talky",
  model: "gemini-2.0-flash",
  replyOnlyOnMention: false,
  askBeforeReply: false,
  alwaysReplyInAllowedGroups: false,
  directChatMode: "allowlist",
  selfSenderJids: [],
  proactiveOnStartupEnabled: false,
  proactiveOnStartupDirectJids: [],
  allowedGroupJids: [],
  mutedGroupJids: [],
  allowedDirectJids: [],
  historyWindow: 15,
  senderHistoryWindow: 5,
  selfHistoryWindow: 3,
  memoryTopK: 5,
  minReplyDelayMs: 2_000,
  maxReplyDelayMs: 5_000,
  dailyMessageLimit: 200,
  maxInputMediaBytes: 6_000_000
};

export function ensureRuntimeDirs(): void {
  for (const folder of [
    DATA_DIR,
    CHAT_DIR,
    LOG_DIR,
    MEMORY_DIR,
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
  const mem0ApiKey =
    process.env.MEM0_API_KEY ?? process.env.memo_api_key ?? process.env.MEMO_API_KEY;

  if (!geminiApiKey) {
    throw new Error(
      "Gemini API key missing. Set GEMINI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY in .env"
    );
  }

  return { geminiApiKey, mem0ApiKey };
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
    senderHistoryWindow: parsed?.senderHistoryWindow ?? defaultConfig.senderHistoryWindow,
    selfHistoryWindow: parsed?.selfHistoryWindow ?? defaultConfig.selfHistoryWindow
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
