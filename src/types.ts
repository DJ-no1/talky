export type ReplyDecision = "YES" | "NO" | "DEFER";

export type MemoryItem = {
  fact: string;
  confidence: number;
  source: string;
  /** When this fact was last reinforced (same as write time on first insert). */
  lastReinforcedISO?: string;
};

export type MessageRecord = {
  chatJid: string;
  senderJid: string;
  timestampISO: string;
  role: "incoming" | "outgoing";
  text: string;
  /** Outgoing line typed on your phone (not sent by Talky). Serialized in chat md as a fourth meta token. */
  manualOutbound?: boolean;
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
  /** When true, still append incoming messages from non-allowed chats to `data/chats/*.md` (Talky will not reply). */
  appendHistoryForDisallowedChats: boolean;
  /** When true, log messages you send manually from the WhatsApp app (fromMe) as outgoing lines so Chats + Inbox stay in sync. */
  recordManualOutboundMessages: boolean;
  /** Additional JIDs treated as “this device” for self-chat (@lid / multi-device). Resolve with `bun run self:add` if WhatsApp uses a JID that does not match your phone JID. */
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
  /** When soul/communication_rules still look like templates; injected into the reply prompt. */
  personaSetupHints?: string[];
};

export type AppEnv = {
  geminiApiKey: string;
  geminiTtsModel?: string;
  mem0ApiKey?: string;
  klipyAppKey?: string;
  klipyLocale?: string;
  klipyContentFilter?: "off" | "low" | "medium" | "high";
  voiceboxBaseUrl?: string;
  voiceboxProfileId?: string;
  voiceboxLanguage?: string;
  voiceboxEngine?: string;
  voiceboxModelSize?: string;
};
