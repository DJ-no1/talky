import { compactText } from "./utils";
import type { GeminiToolCall, GeminiToolDeclaration } from "./types";

export type GeminiTextPart =
  | {
      text: string;
    }
  | {
      inline_data: {
        mime_type: string;
        data: string;
      };
    };

export type GeminiFunctionResponsePart = {
  functionResponse: {
    name: string;
    response: {
      name: string;
      content: unknown;
    };
  };
};

type GeminiPart = GeminiTextPart;

export type GeminiConversationPart = GeminiTextPart | GeminiFunctionResponsePart;

export type GeminiConversationContent = {
  role: "user" | "model";
  parts: GeminiConversationPart[];
};

export type GeminiGenerateWithToolsResult = {
  text: string;
  toolCalls: GeminiToolCall[];
  modelParts: Array<{ text?: string; functionCall?: { name?: string; args?: unknown } }>;
};

type GenerateRequest = {
  model: string;
  systemInstruction?: string;
  parts: GeminiPart[];
  temperature?: number;
  maxOutputTokens?: number;
};

type GenerateWithToolsRequest = {
  model: string;
  systemInstruction?: string;
  contents: GeminiConversationContent[];
  tools: GeminiToolDeclaration[];
  temperature?: number;
  maxOutputTokens?: number;
};

type GeminiGenerateResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string; functionCall?: { name?: string; args?: unknown } }>;
    };
  }>;
};

export class GeminiClient {
  constructor(private readonly apiKey: string) {}

  async generate({
    model,
    systemInstruction,
    parts,
    temperature = 0.4,
    maxOutputTokens = 256
  }: GenerateRequest): Promise<string> {
    const payload: Record<string, unknown> = {
      contents: [{ role: "user", parts }],
      generationConfig: {
        temperature,
        maxOutputTokens
      }
    };

    if (systemInstruction) {
      payload.systemInstruction = {
        role: "system",
        parts: [{ text: systemInstruction }]
      };
    }

    const data = await this.requestGenerateContent(model, payload);

    const text = data.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join(" ")
      .trim();

    return compactText(text ?? "");
  }

  async generateWithTools({
    model,
    systemInstruction,
    contents,
    tools,
    temperature = 0.4,
    maxOutputTokens = 220
  }: GenerateWithToolsRequest): Promise<GeminiGenerateWithToolsResult> {
    const payload: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature,
        maxOutputTokens
      }
    };

    if (systemInstruction) {
      payload.systemInstruction = {
        role: "system",
        parts: [{ text: systemInstruction }]
      };
    }

    if (tools.length > 0) {
      payload.tools = [
        {
          functionDeclarations: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
          }))
        }
      ];
    }

    const data = await this.requestGenerateContent(model, payload);
    const modelParts = data.candidates?.[0]?.content?.parts ?? [];

    const text = compactText(
      modelParts
        .map((part) => part.text ?? "")
        .join(" ")
        .trim()
    );

    const toolCalls: GeminiToolCall[] = modelParts
      .filter((part) => typeof part.functionCall?.name === "string")
      .map((part) => ({
        name: String(part.functionCall?.name ?? "").trim(),
        args: normalizeFunctionArgs(part.functionCall?.args)
      }))
      .filter((call) => call.name.length > 0);

    return {
      text,
      toolCalls,
      modelParts
    };
  }

  private async requestGenerateContent(
    model: string,
    payload: Record<string, unknown>
  ): Promise<GeminiGenerateResponse> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Gemini request failed (${response.status}): ${detail}`);
    }

    return (await response.json()) as GeminiGenerateResponse;
  }
}

function normalizeFunctionArgs(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore malformed tool args and fall through
    }
  }
  return {};
}
