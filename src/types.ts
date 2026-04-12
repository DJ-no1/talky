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

export type IncomingContext = {
  chatJid: string;
  senderJid: string;
  isGroup: boolean;
  groupName?: string;
  text: string;
  mentionedMe: boolean;
  media?: {
    mimeType: string;
    bytes: Buffer;
    caption?: string;
  };
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
  historyWindow: number;
  senderHistoryWindow: number;
  selfHistoryWindow: number;
  memoryTopK: number;
  minReplyDelayMs: number;
  maxReplyDelayMs: number;
  dailyMessageLimit: number;
  maxInputMediaBytes: number;
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
  mem0ApiKey?: string;
};
