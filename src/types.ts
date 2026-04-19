export type ReplyDecision = "YES" | "NO" | "DEFER";

export type MemoryItem = {
  fact: string;
  confidence: number;
  source: string;
};

export type MessageRecord = {
  chatJid: string;
  senderJid: string;
  timestampISO: string;
  role: "incoming" | "outgoing";
  text: string;
};

export type IncomingMediaKind = "image" | "audio" | "video" | "sticker" | "document";

export type IncomingMedia = {
  kind: IncomingMediaKind;
  mimeType: string;
  bytes: Buffer;
  caption?: string;
  fileName?: string;
  isAnimated?: boolean;
};

export type IncomingContext = {
  chatJid: string;
  senderJid: string;
  isGroup: boolean;
  groupName?: string;
  text: string;
  mentionedMe: boolean;
  media?: IncomingMedia;
};

export type GeminiToolCall = {
  id?: string;
  name: string;
  args: Record<string, unknown>;
};

export type GeminiToolDeclaration = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ToolExecutionResult = {
  ok: boolean;
  message: string;
  data?: unknown;
  sentMessage?: boolean;
};

export type AppConfig = {
  botName: string;
  model: string;
  runtimeLogMode: "minimal" | "verbose";
  replyOnlyOnMention: boolean;
  askBeforeReply: boolean;
  alwaysReplyInAllowedGroups: boolean;
  directChatMode: "allowlist" | "all" | "none";
  selfSenderJids: string[];
  proactiveOnStartupEnabled: boolean;
  proactiveOnStartupDirectJids: string[];
  allowedGroupJids: string[];
  mutedGroupJids: string[];
  allowedDirectJids: string[];
  selfChatEnabled: boolean;
  historyWindow: number;
  senderHistoryWindow: number;
  selfHistoryWindow: number;
  memoryTopK: number;
  minReplyDelayMs: number;
  maxReplyDelayMs: number;
  dailyMessageLimit: number;
  maxInputMediaBytes: number;
  toolCallingEnabled: boolean;
  toolLoopMaxSteps: number;
  maxToolReadFileBytes: number;
  maxShareFileBytes: number;
  localFileAllowedRoots: string[];
  localFileBlockedExtensions: string[];
  localFileBlockedPathFragments: string[];
  allowShareToAllowedGroups: boolean;
  stickerPackDir: string;
  allowForwardIncomingStickers: boolean;
  stickerReplyMode: "model" | "always-sticker" | "explicit-only";
  selfChatDigestHour: number;
  selfChatDigestEnabled: boolean;
  selfChatReminderPollSeconds: number;
  memoryBackend: "hybrid" | "legacy";
  memoryEmbeddingsEnabled: boolean;
  memoryConsolidationHours: number;
  startupGraceSeconds: number;
  staleMessageMaxAgeSeconds: number;
};

export type PersonaContext = {
  soul: string;
  communicationRules: string;
  recentMemory: string;
  contactProfile: string;
  groupProfile: string;
};

export type AppEnv = {
  geminiApiKey: string;
  geminiTtsModel?: string;
  mem0ApiKey?: string;
  klipyAppKey?: string;
  klipyLocale?: string;
  klipyContentFilter?: "off" | "low" | "medium" | "high";
};
