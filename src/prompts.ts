import type { MemoryItem, PersonaContext } from "./types";

export function buildDecisionPrompt(args: {
  botName: string;
  mentionedMe: boolean;
  isGroup: boolean;
  message: string;
  recentHistory: string[];
  memories: MemoryItem[];
}): string {
  const memoryText =
    args.memories.length === 0
      ? "None"
      : args.memories
          .map((m, i) => `${i + 1}. ${m.fact} (confidence=${m.confidence.toFixed(2)})`)
          .join("\n");

  const history = args.recentHistory.length === 0 ? "None" : args.recentHistory.join("\n");

  return [
    `You are an assistant deciding if ${args.botName} should reply in WhatsApp.`,
    "Output exactly one token: YES, NO, or DEFER.",
    "Hard rule: if explicitly mentioned, output YES.",
    `Mentioned: ${args.mentionedMe ? "yes" : "no"}`,
    `Chat type: ${args.isGroup ? "group" : "direct"}`,
    `Incoming message: ${args.message}`,
    `Recent history:\n${history}`,
    `Relevant memories:\n${memoryText}`
  ].join("\n\n");
}

export function buildReplySystemPrompt(args: {
  botName: string;
  memories: MemoryItem[];
  recentHistory: string[];
  recentSenderMessages: string[];
  ownRecentMessages: string[];
  persona: PersonaContext;
  isGroup: boolean;
}): string {
  const memoryText =
    args.memories.length === 0
      ? "No memory available."
      : args.memories.map((m) => `- ${m.fact}`).join("\n");

  const history = args.recentHistory.length === 0 ? "- none" : args.recentHistory.join("\n");
  const senderHistory =
    args.recentSenderMessages.length === 0
      ? "- none"
      : args.recentSenderMessages.map((line) => `- ${line}`).join("\n");
  const ownHistory =
    args.ownRecentMessages.length === 0
      ? "- none"
      : args.ownRecentMessages.map((line) => `- ${line}`).join("\n");
  const setupHints =
    args.persona.personaSetupHints && args.persona.personaSetupHints.length > 0
      ? `\n\nPersona completeness (fix in persona/*.md):\n${args.persona.personaSetupHints
          .map((h) => `- ${h}`)
          .join("\n")}`
      : "";

  const personaSections = [
    `Soul:\n${args.persona.soul || "- none"}`,
    `Communication Rules:\n${args.persona.communicationRules || "- none"}`,
    `Recent Memory:\n${args.persona.recentMemory || "- none"}`,
    `Contact Relationship Profile:\n${args.persona.contactProfile || "- none"}`,
    args.isGroup ? `Group Position Profile:\n${args.persona.groupProfile || "- none"}` : "",
    setupHints
  ]
    .filter(Boolean)
    .join("\n\n");

  return [
    `You are ${args.botName}, writing a WhatsApp message.`,
    "You are acting on behalf of the real user. Sound like them, not like an AI assistant.",
    "Tone: funny, warm, and human.",
    "Language style: casual Banglish/Benglish (mix English with simple Bengali words in Latin script).",
    "Do not overdo slang. Keep it readable.",
    args.isGroup
      ? "For group chats: keep it concise; if unnecessary, return exactly NO_REPLY."
      : "For direct 1:1 chats: always respond helpfully and playfully.",
    "Default: send exactly ONE message. Only if it genuinely helps (e.g. a clear afterthought or a separate follow-up question) send TWO messages — split with delimiter ||| between them. Never send more than two. Never split just to look chatty.",
    "Do not invent facts. Use only context and memory below.",
    `Persona Context:\n${personaSections}`,
    `Last messages from this person (4-5):\n${senderHistory}`,
    `My own latest 2-3 messages in this chat:\n${ownHistory}`,
    `Memory:\n${memoryText}`,
    `Recent chat:\n${history}`
  ].join("\n\n");
}
