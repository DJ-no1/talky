import {
  FunctionCallingConfigMode,
  GoogleGenAI,
  type Content,
  type FunctionDeclaration,
  type GenerateContentResponse,
  type Part,
  type Tool
} from "@google/genai";
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
    id?: string;
    name: string;
    response: Record<string, unknown>;
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

export type GeminiTtsSpeaker = {
  speaker: string;
  voiceName: string;
};

export type GeminiGenerateSpeechResult = {
  pcmData: Buffer;
  mimeType: string;
  sampleRateHz: number;
  model: string;
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

type GenerateSpeechRequest = {
  model: string;
  prompt: string;
  voiceName?: string;
  speakers?: GeminiTtsSpeaker[];
};

export class GeminiClient {
  private readonly client: GoogleGenAI;

  constructor(private readonly apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async generate({
    model,
    systemInstruction,
    parts,
    temperature = 0.4,
    maxOutputTokens = 256
  }: GenerateRequest): Promise<string> {
    const response = await this.client.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: parts.map((part) => toSdkPart(part))
        }
      ],
      config: {
        temperature,
        maxOutputTokens,
        ...(systemInstruction
          ? {
              systemInstruction: toSystemInstruction(systemInstruction)
            }
          : {})
      }
    });

    return extractTextFromResponse(response);
  }

  async generateWithTools({
    model,
    systemInstruction,
    contents,
    tools,
    temperature = 0.4,
    maxOutputTokens = 220
  }: GenerateWithToolsRequest): Promise<GeminiGenerateWithToolsResult> {
    const sdkTools: Tool[] =
      tools.length > 0
        ? [
            {
              functionDeclarations: tools.map((tool) => toSdkFunctionDeclaration(tool))
            }
          ]
        : [];

    const response = await this.client.models.generateContent({
      model,
      contents: contents.map((content) => toSdkContent(content)),
      config: {
        temperature,
        maxOutputTokens,
        ...(systemInstruction
          ? {
              systemInstruction: toSystemInstruction(systemInstruction)
            }
          : {}),
        ...(sdkTools.length > 0
          ? {
              tools: sdkTools,
              toolConfig: {
                functionCallingConfig: {
                  mode: FunctionCallingConfigMode.AUTO
                }
              }
            }
          : {})
      }
    });

    const text = extractTextFromResponse(response);

    const toolCalls: GeminiToolCall[] = (response.functionCalls ?? [])
      .map((call) => ({
        id: call.id,
        name: String(call.name ?? "").trim(),
        args: normalizeFunctionArgs(call.args)
      }))
      .filter((call) => call.name.length > 0);

    const modelParts = extractModelParts(response);

    return {
      text,
      toolCalls,
      modelParts
    };
  }

  async generateSpeech({
    model,
    prompt,
    voiceName,
    speakers
  }: GenerateSpeechRequest): Promise<GeminiGenerateSpeechResult> {
    const textPrompt = compactText(prompt);
    if (!textPrompt) {
      throw new Error("TTS prompt is empty");
    }

    const cleanSpeakers = (speakers ?? [])
      .map((speaker) => ({
        speaker: compactText(speaker.speaker),
        voiceName: compactText(speaker.voiceName)
      }))
      .filter((speaker) => speaker.speaker.length > 0 && speaker.voiceName.length > 0)
      .slice(0, 2);

    const request = {
      model,
      contents: [{ role: "user", parts: [{ text: textPrompt }] }],
      config: {
        responseModalities: ["AUDIO"],
        speechConfig:
          cleanSpeakers.length >= 2
            ? {
                multiSpeakerVoiceConfig: {
                  speakerVoiceConfigs: cleanSpeakers.map((speaker) => ({
                    speaker: speaker.speaker,
                    voiceConfig: {
                      prebuiltVoiceConfig: {
                        voiceName: speaker.voiceName
                      }
                    }
                  }))
                }
              }
            : {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: compactText(voiceName || "Kore") || "Kore"
                  }
                }
              }
      }
    };

    const response = (await this.client.models.generateContent(
      request as never
    )) as GenerateContentResponse;

    const audio = extractAudioInlineData(response);
    if (!audio?.data) {
      throw new Error("TTS response did not contain audio data");
    }

    const mimeType = audio.mimeType || "audio/pcm;rate=24000";
    const sampleRateHz = parsePcmSampleRate(mimeType);

    return {
      pcmData: Buffer.from(audio.data, "base64"),
      mimeType,
      sampleRateHz,
      model
    };
  }
}

function toSdkContent(content: GeminiConversationContent): Content {
  return {
    role: content.role,
    parts: content.parts.map((part) => toSdkPart(part))
  };
}

function toSdkPart(part: GeminiConversationPart): Part {
  if ("text" in part) {
    return {
      text: part.text
    };
  }

  if ("inline_data" in part) {
    return {
      inlineData: {
        mimeType: part.inline_data.mime_type,
        data: part.inline_data.data
      }
    };
  }

  return {
    functionResponse: {
      id: part.functionResponse.id,
      name: part.functionResponse.name,
      response: normalizeFunctionResponse(part.functionResponse.response)
    }
  };
}

function toSystemInstruction(systemInstruction: string): Part[] {
  return [{ text: systemInstruction }];
}

function toSdkFunctionDeclaration(tool: GeminiToolDeclaration): FunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.parameters
  };
}

function extractModelParts(
  response: GenerateContentResponse
): Array<{ text?: string; functionCall?: { name?: string; args?: unknown } }> {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  return parts.map((part) => ({
    text: part.text,
    functionCall: part.functionCall
      ? {
          name: part.functionCall.name,
          args: part.functionCall.args
        }
      : undefined
  }));
}

function normalizeFunctionResponse(response: Record<string, unknown>): Record<string, unknown> {
  if (response && typeof response === "object" && !Array.isArray(response)) {
    return response;
  }
  return { output: response };
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

function extractAudioInlineData(
  response: GenerateContentResponse
): { data?: string; mimeType?: string } | null {
  const candidates = response.candidates ?? [];
  for (const candidate of candidates) {
    const parts = candidate.content?.parts ?? [];
    for (const part of parts) {
      const direct = (part as { inlineData?: { data?: string; mimeType?: string } }).inlineData;
      if (direct?.data) {
        return {
          data: direct.data,
          mimeType: direct.mimeType
        };
      }

      const legacy = (part as { inline_data?: { data?: string; mime_type?: string } })
        .inline_data;
      if (legacy?.data) {
        return {
          data: legacy.data,
          mimeType: legacy.mime_type
        };
      }
    }
  }

  return null;
}

function parsePcmSampleRate(mimeType: string): number {
  const match = mimeType.match(/(?:rate|sample_rate|samplerate)=([0-9]{4,6})/i);
  if (!match) return 24_000;
  const parsed = Number.parseInt(match[1], 10);
  if (!Number.isFinite(parsed) || parsed < 8_000 || parsed > 96_000) {
    return 24_000;
  }
  return parsed;
}

function extractTextFromResponse(response: GenerateContentResponse): string {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join(" ");
  return compactText(text);
}
