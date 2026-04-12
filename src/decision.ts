import type { AppConfig, ReplyDecision } from "./types";
import { GeminiClient } from "./gemini";
import { buildDecisionPrompt } from "./prompts";
import type { MemoryItem } from "./types";

export async function decideReply(args: {
  gemini: GeminiClient;
  config: AppConfig;
  botName: string;
  isGroup: boolean;
  mentionedMe: boolean;
  messageText: string;
  recentHistory: string[];
  memories: MemoryItem[];
}): Promise<ReplyDecision> {
  if (args.mentionedMe) return "YES";
  if (args.config.replyOnlyOnMention) return "NO";

  const prompt = buildDecisionPrompt({
    botName: args.botName,
    mentionedMe: args.mentionedMe,
    isGroup: args.isGroup,
    message: args.messageText,
    recentHistory: args.recentHistory,
    memories: args.memories
  });

  const result = await args.gemini.generate({
    model: args.config.model,
    parts: [{ text: prompt }],
    temperature: 0.1,
    maxOutputTokens: 8
  });

  const token = result.trim().toUpperCase();
  if (token.includes("YES")) return "YES";
  if (token.includes("DEFER")) return "DEFER";
  return "NO";
}
