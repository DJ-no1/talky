import { compactText } from "./utils";

type GeminiPart =
  | {
      text: string;
    }
  | {
      inline_data: {
        mime_type: string;
        data: string;
      };
    };

type GenerateRequest = {
  model: string;
  systemInstruction?: string;
  parts: GeminiPart[];
  temperature?: number;
  maxOutputTokens?: number;
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
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`;
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

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Gemini request failed (${response.status}): ${detail}`);
    }

    const data = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
    };

    const text = data.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join(" ")
      .trim();

    return compactText(text ?? "");
  }
}
