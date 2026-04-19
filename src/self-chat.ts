import type {
  GeminiClient,
  GeminiConversationContent,
  GeminiConversationPart
} from "./gemini";
import type {
  AppConfig,
  GeminiToolCall,
  GeminiToolDeclaration,
  ToolExecutionResult
} from "./types";
import { Summarizer, formatDigestReply } from "./summarizer";
import {
  addReminder,
  cancelReminder,
  formatReminderSummary,
  listReminders,
  parseReminderHeuristic
} from "./reminders";
import { applyNaturalLanguageInstruction } from "./instruction-handler";
import type { MemoryService } from "./memory";
import { compactText } from "./utils";

export type SelfChatIntent =
  | { kind: "help" }
  | { kind: "summary"; target: string; hours: number }
  | { kind: "digest"; hours: number }
  | {
      kind: "reminder_set";
      text: string;
      dueAtISO: string;
      confidence: number;
    }
  | { kind: "reminder_list" }
  | { kind: "reminder_cancel"; id: string }
  | { kind: "behavior_instruction"; payload: string }
  | { kind: "memory_query"; query: string }
  | { kind: "assistant_chat"; text: string };

export type SelfChatDeps = {
  getConfig: () => AppConfig;
  getOwnerJid: () => string;
  gemini: GeminiClient;
  summarizer: Summarizer;
  memory: MemoryService;
  resolveGroupLabel: (jid: string) => string;
  resolveGroupJid: (query: string) => Promise<string | null>;
  updateConfigSnapshot: (next: AppConfig) => void;
  // Full agent-side tool access. When provided, the assistant-chat path uses
  // these to call send_voice_reply, send_sticker, send_image_reply, share_local_file, etc.
  getToolDeclarations?: () => GeminiToolDeclaration[];
  runTool?: (
    call: GeminiToolCall,
    chatJid: string,
    senderJid: string
  ) => Promise<ToolExecutionResult>;
};

export type SelfChatContext = {
  chatJid: string;
  senderJid: string;
};

export type SelfChatResponse = {
  replies: string[];
  handled: boolean;
  intent: SelfChatIntent["kind"];
};

const HELP_TEXT = [
  "Hey, self-chat mode. What I can do:",
  "",
  "• /help — show this",
  "• /summary <group jid or keyword> [24h] — recap a chat",
  "• /digest [24h] — daily digest across all chats",
  "• /remind <what> in 30m | at 9pm | tomorrow 10am",
  "• /reminders — list pending reminders",
  "• /cancel <reminder-id>",
  "• /tune <instruction> — natural-language persona/config tuning",
  "• /ask <question> — ask your memory",
  "",
  "Or just talk to me plainly — I'll guess the intent."
].join("\n");

export class SelfChatAssistant {
  constructor(private readonly deps: SelfChatDeps) {}

  async handle(text: string, context?: SelfChatContext): Promise<SelfChatResponse> {
    const normalized = compactText(text);
    if (!normalized) {
      return { replies: [], handled: false, intent: "assistant_chat" };
    }

    const intent = await this.classify(normalized);
    const replies = await this.execute(intent, context);
    // handled=true means self-chat owns this message — the caller must NOT
    // fall through to the normal agent path, even if replies is empty
    // (e.g. a tool already sent a voice note directly).
    return { replies, handled: true, intent: intent.kind };
  }

  private async classify(text: string): Promise<SelfChatIntent> {
    const lower = text.toLowerCase().trim();

    if (lower === "/help" || lower === "help" || lower === "?") {
      return { kind: "help" };
    }

    if (lower.startsWith("/summary") || lower.startsWith("summarize ")) {
      const rest = text.replace(/^\/summary\s*|^summarize\s*/i, "").trim();
      const hours = parseHours(rest) ?? 24;
      const target = rest.replace(/\b\d+\s*(?:h|hours?|hr)?\b/gi, "").trim() || "all";
      return { kind: "summary", target, hours };
    }

    if (lower.startsWith("/digest") || lower.startsWith("digest")) {
      const rest = text.replace(/^\/digest\s*|^digest\s*/i, "").trim();
      const hours = parseHours(rest) ?? 24;
      return { kind: "digest", hours };
    }

    if (lower.startsWith("/reminders") || /^(?:list|show)\s+(?:my\s+)?reminders?\b/i.test(text)) {
      return { kind: "reminder_list" };
    }

    const cancelMatch = text.match(/^\/?cancel\s+([a-f0-9]{6,})\b/i);
    if (cancelMatch && cancelMatch[1]) {
      return { kind: "reminder_cancel", id: cancelMatch[1].toLowerCase() };
    }

    if (lower.startsWith("/remind") || /^remind\s+me\b/i.test(text)) {
      const body = text.replace(/^\/remind\s*|^remind\s+me\s*/i, "").trim();
      const parsed = parseReminderHeuristic(body);
      if (parsed) {
        return {
          kind: "reminder_set",
          text: parsed.text,
          dueAtISO: parsed.dueAtISO,
          confidence: parsed.confidence
        };
      }
      const llmParsed = await this.parseReminderWithLLM(body);
      if (llmParsed) {
        return {
          kind: "reminder_set",
          text: llmParsed.text,
          dueAtISO: llmParsed.dueAtISO,
          confidence: llmParsed.confidence
        };
      }
      return { kind: "assistant_chat", text };
    }

    if (lower.startsWith("/tune") || /^(?:please\s+)?(?:be\s+more\b|don'?t\s+use\b|add\s+to\s+soul\b|add\s+to\s+rules\b|mute\s+group\b|unmute\s+group\b|only\s+reply\s+on\s+mention\b|reply\s+(?:more\s+)?(?:slowly|faster)\b|daily\s+(?:limit|messages))/i.test(text)) {
      const payload = text.replace(/^\/tune\s*/i, "").trim();
      return { kind: "behavior_instruction", payload };
    }

    if (lower.startsWith("/ask") || /^(?:who\s+is|what\s+do\s+(?:you|i)\s+know|remind\s+me\s+about)\b/i.test(text)) {
      const query = text.replace(/^\/ask\s*/i, "").trim();
      return { kind: "memory_query", query };
    }

    const parsed = parseReminderHeuristic(text);
    if (parsed && parsed.confidence >= 0.8) {
      return {
        kind: "reminder_set",
        text: parsed.text,
        dueAtISO: parsed.dueAtISO,
        confidence: parsed.confidence
      };
    }

    return { kind: "assistant_chat", text };
  }

  private async execute(intent: SelfChatIntent, context?: SelfChatContext): Promise<string[]> {
    switch (intent.kind) {
      case "help":
        return [HELP_TEXT];

      case "summary":
        return this.runSummary(intent.target, intent.hours);

      case "digest":
        return this.runDigest(intent.hours);

      case "reminder_set": {
        const reminder = addReminder({
          ownerJid: this.deps.getOwnerJid(),
          text: intent.text,
          dueAtISO: intent.dueAtISO,
          targetJid: this.deps.getOwnerJid()
        });
        return [`Reminder set (${reminder.id}) — ${formatReminderSummary(reminder)}`];
      }

      case "reminder_list": {
        const rows = listReminders(this.deps.getOwnerJid()).filter((r) => !r.notified);
        if (rows.length === 0) return ["No pending reminders."];
        return [
          [
            `You have ${rows.length} reminder${rows.length === 1 ? "" : "s"}:`,
            ...rows.slice(0, 15).map((r) => `• ${formatReminderSummary(r)}`)
          ].join("\n")
        ];
      }

      case "reminder_cancel": {
        const removed = cancelReminder(intent.id, this.deps.getOwnerJid());
        return [removed ? `Reminder ${intent.id} cancelled.` : `No reminder with id ${intent.id}.`];
      }

      case "behavior_instruction": {
        const result = await applyNaturalLanguageInstruction(intent.payload, {
          config: this.deps.getConfig(),
          saveConfigSnapshot: (next) => this.deps.updateConfigSnapshot(next)
        });
        return [result.message];
      }

      case "memory_query":
        return this.runMemoryQuery(intent.query);

      case "assistant_chat":
        return this.runAssistantChat(intent.text, context);
    }
  }

  private async runSummary(rawTarget: string, hours: number): Promise<string[]> {
    const target = rawTarget.trim();
    if (!target || target.toLowerCase() === "all") {
      return this.runDigest(hours);
    }

    const jid = /@/i.test(target)
      ? target
      : (await this.deps.resolveGroupJid(target)) ?? null;
    if (!jid) {
      return [
        `Couldn't find a chat matching "${target}". Use a JID or a unique word from the group name.`
      ];
    }

    const summary = await this.deps.summarizer.summarizeChat({
      chatJid: jid,
      chatLabel: this.deps.resolveGroupLabel(jid),
      hours,
      model: this.deps.getConfig().model
    });

    const lines = [
      `*${this.deps.resolveGroupLabel(jid)}* • last ${hours}h • ${summary.messageCount} msgs`,
      "",
      summary.summary
    ];
    if (summary.actionItems.length > 0) {
      lines.push("", "Actions:");
      for (const item of summary.actionItems.slice(0, 6)) {
        lines.push(`• ${item}`);
      }
    }
    return [lines.join("\n")];
  }

  private async runDigest(hours: number): Promise<string[]> {
    const entries = await this.deps.summarizer.buildDigest(
      {
        hours,
        model: this.deps.getConfig().model
      },
      this.deps.resolveGroupLabel
    );
    return [formatDigestReply(entries, hours)];
  }

  private async runMemoryQuery(query: string): Promise<string[]> {
    if (!query.trim()) return ["Ask me about something: `/ask who is Anita`."];
    await this.deps.memory.ensureReady();
    const items = await this.deps.memory.retrieve(this.deps.getOwnerJid(), query, 8);
    if (items.length === 0) return [`No memory matching "${query}".`];
    const lines = [`Memory matches for "${query}":`];
    for (const item of items.slice(0, 8)) {
      const score = Math.round((item.confidence ?? 0) * 100);
      lines.push(`• (${score}%) ${item.fact}`);
    }
    return [lines.join("\n")];
  }

  private async runAssistantChat(text: string, context?: SelfChatContext): Promise<string[]> {
    await this.deps.memory.ensureReady();
    if (isAssistantMemoryCue(text)) {
      await this.deps.memory
        .remember(this.deps.getOwnerJid(), text, "self_chat_note")
        .catch(() => undefined);
    }

    // When the agent-side tool runtime is wired in (voice/sticker/image/file/memory),
    // use the full tool set so the assistant can actually *do* things, not just talk.
    const agentTools =
      this.deps.getToolDeclarations && this.deps.runTool
        ? this.deps.getToolDeclarations()
        : null;
    const tools = agentTools && agentTools.length > 0 ? agentTools : buildSelfChatTools();
    const hasAgentTools = tools === agentTools;

    const toolCatalog = tools
      .map((t) => `  • ${t.name} — ${compactText(t.description ?? "")}`)
      .join("\n");

    const systemInstruction = [
      "You are the account owner's personal WhatsApp assistant in their self-chat.",
      "Reply as a terse, trusted confidant — speak as yourself, never pretend to be the owner.",
      "",
      "HARD RULES — violating these is a failure:",
      "1. The ONLY capabilities you have are the tools listed below. You have NO access to email, Gmail, Slack, calendars, Google Workspace, the web, files outside what share_local_file exposes, or any account other than this WhatsApp session. If asked about such things, say plainly you don't have that integration — do NOT pretend, do NOT say 'okay, checking', do NOT fabricate results.",
      "2. Never invent meetings, names, times, events, email contents, or any factual data. If `recall_memory` returns nothing, say you don't have a record — don't guess.",
      "3. If the owner asks you to DO something (send a voice note, sticker, image, save a fact, recall memory), you MUST call the matching tool in this same turn. Saying 'recording now' or 'okay, saved' without actually invoking the tool is forbidden.",
      "4. Before answering a factual question about the owner's life ('do I have a meeting?', 'what did X say?', 'when is Y?'), call `recall_memory` first.",
      "5. When the owner shares a durable fact (meeting, reminder, person info, preference), call `remember_fact`.",
      "6. PROACTIVE sticker use: when a reply would naturally land better as a sticker (reactions like 'lol', 'nice', 'ugh', 'gm', 'gn', agreement, tease, celebration, thanks, a light emotional beat) — call `send_sticker` with a short `query` keyword (e.g. query='laugh', 'thumbs up', 'sad', 'love', 'goodnight'). Don't overdo it; one sticker per turn max, only when it genuinely fits the vibe. Never narrate 'sending sticker' — just call the tool.",
      "7. NO NARRATED TOOL USE: if your reply text mentions or implies sending a sticker/voice/image/gif/file ('sticker pathachchi', 'sending sticker', 'ei nao', 'ekhoni pathachchi', etc.), you MUST invoke the matching tool in this same turn. Narrating without invoking is forbidden — either call the tool or don't mention the action.",
      "",
      "Available tools (this is the complete list — nothing else exists):",
      toolCatalog,
      "",
      "If the owner asks what you can do, answer from the tool catalog above — do NOT refuse.",
      "Style: terse, under 120 words. No markdown tables. No fake placeholders like '[Subject of email]'."
    ].join("\n");

    const conversation: GeminiConversationContent[] = [
      { role: "user", parts: [{ text }] }
    ];

    try {
      const maxSteps = 4;
      let anyToolSentMessage = false;
      for (let step = 0; step < maxSteps; step += 1) {
        const response = await this.deps.gemini.generateWithTools({
          model: this.deps.getConfig().model,
          systemInstruction,
          contents: conversation,
          tools,
          temperature: 0.4,
          maxOutputTokens: 320
        });

        if (response.toolCalls.length === 0) {
          const out = compactText(response.text);
          if (out) return [out];
          return anyToolSentMessage ? [] : ["(no reply)"];
        }

        const functionResponseParts: GeminiConversationPart[] = [];
        for (const call of response.toolCalls) {
          const result =
            hasAgentTools && this.deps.runTool && context
              ? await this.deps.runTool(call, context.chatJid, context.senderJid)
              : await this.executeSelfChatToolResult(call.name, call.args);
          if (result.sentMessage) anyToolSentMessage = true;
          functionResponseParts.push({
            functionResponse: {
              id: call.id,
              name: call.name,
              response: toFunctionResponsePayload(result)
            }
          });
        }

        conversation.push({
          role: "model",
          parts:
            response.modelParts.length > 0
              ? response.modelParts
              : [{ text: `Executed ${response.toolCalls.length} tool call(s).` }]
        });
        conversation.push({ role: "user", parts: functionResponseParts });
      }

      return ["(tool loop exceeded; no final reply)"];
    } catch (error) {
      return [`Assistant error: ${stringifyError(error)}`];
    }
  }

  private async executeSelfChatToolResult(
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolExecutionResult> {
    const ownerJid = this.deps.getOwnerJid();
    if (name === "recall_memory") {
      const query = compactText(typeof args.query === "string" ? args.query : "");
      if (!query) return { ok: false, message: "recall_memory: query is required" };
      const limit =
        typeof args.limit === "number" && Number.isFinite(args.limit)
          ? Math.max(1, Math.min(15, Math.floor(args.limit)))
          : 6;
      const items = await this.deps.memory.retrieve(ownerJid, query, limit);
      return {
        ok: true,
        message:
          items.length > 0
            ? `found ${items.length} memory item(s)`
            : `no memory matches for "${query}"`,
        data: {
          items: items.map((m) => ({
            fact: m.fact,
            confidence: m.confidence,
            source: m.source
          }))
        }
      };
    }
    if (name === "remember_fact") {
      const fact = compactText(typeof args.fact === "string" ? args.fact : "");
      if (!fact) return { ok: false, message: "remember_fact: fact is required" };
      const source =
        typeof args.source === "string" && args.source.trim()
          ? args.source.trim()
          : "self_chat_tool";
      await this.deps.memory.remember(ownerJid, fact, source);
      return { ok: true, message: `remembered under owner (${ownerJid})`, data: { source } };
    }
    return { ok: false, message: `unknown tool: ${name}` };
  }

  private async parseReminderWithLLM(body: string): Promise<{
    text: string;
    dueAtISO: string;
    confidence: number;
  } | null> {
    if (!body.trim()) return null;
    const nowISO = new Date().toISOString();
    const prompt = [
      "Parse the reminder request into JSON. Use ISO 8601 with local timezone offset from 'now'.",
      `Now: ${nowISO}`,
      `Request: ${body}`,
      "",
      'Return: {"text":"<what to remind>","dueAtISO":"<ISO 8601>","confidence":0-1}',
      "If not parseable, return {\"dueAtISO\":\"\"}."
    ].join("\n");

    try {
      const raw = await this.deps.gemini.generate({
        model: this.deps.getConfig().model,
        parts: [{ text: prompt }],
        temperature: 0,
        maxOutputTokens: 200
      });
      const jsonStart = raw.indexOf("{");
      const jsonEnd = raw.lastIndexOf("}");
      if (jsonStart < 0 || jsonEnd <= jsonStart) return null;
      const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)) as {
        text?: string;
        dueAtISO?: string;
        confidence?: number;
      };
      if (!parsed.dueAtISO) return null;
      const due = Date.parse(parsed.dueAtISO);
      if (!Number.isFinite(due)) return null;
      return {
        text: (parsed.text ?? body).trim(),
        dueAtISO: new Date(due).toISOString(),
        confidence: Math.min(1, Math.max(0, Number(parsed.confidence ?? 0.7)))
      };
    } catch {
      return null;
    }
  }
}

function parseHours(value: string): number | null {
  if (!value) return null;
  const match = value.match(/(\d+)\s*(h|hr|hour|hours|d|day|days)?/i);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = match[2]?.toLowerCase() ?? "h";
  if (unit.startsWith("d")) return Math.min(168, n * 24);
  return Math.min(168, n);
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function toFunctionResponsePayload(result: ToolExecutionResult): Record<string, unknown> {
  return {
    ok: result.ok,
    message: result.message,
    sentMessage: Boolean(result.sentMessage),
    data: result.data ?? null
  };
}

function buildSelfChatTools(): GeminiToolDeclaration[] {
  return [
    {
      name: "recall_memory",
      description:
        "Search the owner's long-term memory for facts relevant to a query. Call this BEFORE answering any factual question about meetings, people, events, or what someone said. Returns ranked matches or empty.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language search query" },
          limit: { type: "integer", description: "Max results (1-15), default 6" }
        },
        required: ["query"]
      }
    },
    {
      name: "remember_fact",
      description:
        "Save a durable fact to the owner's long-term memory. Use when the owner shares something worth recalling (meeting, reminder, person info, preference).",
      parameters: {
        type: "object",
        properties: {
          fact: { type: "string", description: "Concise statement to remember" },
          source: {
            type: "string",
            description: "Optional tag describing the origin, e.g. 'self_chat_note'"
          }
        },
        required: ["fact"]
      }
    }
  ];
}

function isAssistantMemoryCue(text: string): boolean {
  if (!text) return false;
  if (text.length > 220) return false;
  if (/^(who|what|when|where|why|how|do|does|did|is|are|was|were|can|could|should|will|would)\b/i.test(text.trim())) {
    return false;
  }
  if (text.trim().endsWith("?")) return false;
  if (/\b(remember|dont forget|don't forget|note that|keep in mind|save this|fyi)\b/i.test(text)) {
    return true;
  }
  const scheduleVerbs = /\b(meeting|meet|call|appointment|appt|deadline|due|flight|interview|class|exam|party|dinner|lunch)\b/i;
  const timeHints = /\b(at|on|by|tomorrow|tonight|today|am|pm|\d{1,2}(:\d{2})?)\b/i;
  if (scheduleVerbs.test(text) && timeHints.test(text)) return true;
  return false;
}
