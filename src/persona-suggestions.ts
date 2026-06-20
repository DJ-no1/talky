import { GeminiClient } from "./gemini";
import { compactText } from "./utils";

export type PersonaSuggestionTarget = "soul" | "communicationRules" | "recentMemory";

const TARGET_COPY: Record<PersonaSuggestionTarget, string> = {
  soul: "soul.md — identity, name, values, boundaries, relationships",
  communicationRules:
    "communication_rules.md — tone, greetings, slang, phrases you use, how you close chats",
  recentMemory: "recent_memory.md — short-lived priorities, stress points, reminders for this week",
};

export async function suggestPersonaFromTranscript(
  client: GeminiClient,
  model: string,
  args: { transcript: string; target: PersonaSuggestionTarget; currentSection?: string }
): Promise<string> {
  const transcript = compactText(args.transcript).slice(0, 12_000);
  if (!transcript) {
    return "";
  }

  const out = await client.generate({
    model,
    temperature: 0.35,
    maxOutputTokens: 1536,
    systemInstruction: [
      "You improve a WhatsApp bot's persona files for the real human owner.",
      `Target file: ${TARGET_COPY[args.target]}.`,
      "Given a chat transcript, output Markdown ONLY — bullets or short paragraphs the user can paste into that file.",
      "Capture: how they speak, inside jokes, relationships, recurring topics, preferences, habits.",
      "Do not output JSON or code fences around the whole answer. No meta-commentary.",
      "If the transcript has little signal, say so in one short line."
    ].join("\n"),
    parts: [
      {
        text: [
          "### Existing content (may be empty — extend, don't repeat blindly)",
          (args.currentSection ?? "").trim() || "(empty)",
          "",
          "### Chat transcript",
          transcript
        ].join("\n")
      }
    ]
  });

  return compactText(out);
}
