export type VoiceboxGenerateRequest = {
  profileId: string;
  text: string;
  language?: string;
  engine?: string;
  modelSize?: string;
  normalize?: boolean;
};

export type VoiceboxGenerateResult = {
  generationId: string;
  initialStatus: string;
};

export type VoiceboxHistoryResult = {
  id: string;
  status: string;
  error?: string;
};

export type VoiceboxClientOptions = {
  baseUrl: string;
  requestTimeoutMs?: number;
};

export class VoiceboxClient {
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;

  constructor(options: VoiceboxClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.requestTimeoutMs = clampInt(options.requestTimeoutMs ?? 90_000, 5_000, 300_000);
  }

  async checkHealth(): Promise<boolean> {
    const response = await this.fetchJson("/health", { method: "GET" });
    return response.ok;
  }

  async generate(args: VoiceboxGenerateRequest): Promise<VoiceboxGenerateResult> {
    const payload = {
      profile_id: args.profileId,
      text: args.text,
      language: args.language ?? "en",
      engine: args.engine ?? "qwen",
      model_size: args.modelSize ?? "1.7B",
      normalize: args.normalize ?? true
    };

    const response = await this.fetchJson("/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      throw new Error(`voicebox generate failed: ${response.status} ${response.bodyText}`);
    }

    const data = response.data as { id?: string; status?: string } | null;
    const generationId = compactText(data?.id ?? "");
    if (!generationId) {
      throw new Error("voicebox generate returned no generation id");
    }

    return {
      generationId,
      initialStatus: compactText(data?.status ?? "") || "generating"
    };
  }

  async getHistory(generationId: string): Promise<VoiceboxHistoryResult> {
    const safeId = encodeURIComponent(generationId);
    const response = await this.fetchJson(`/history/${safeId}`, { method: "GET" });
    if (!response.ok) {
      throw new Error(`voicebox history failed: ${response.status} ${response.bodyText}`);
    }

    const data = response.data as { id?: string; status?: string; error?: string } | null;
    return {
      id: compactText(data?.id ?? generationId) || generationId,
      status: compactText(data?.status ?? "") || "unknown",
      error: compactText(data?.error ?? "") || undefined
    };
  }

  async waitForCompletion(args: {
    generationId: string;
    pollIntervalMs?: number;
    maxWaitMs?: number;
  }): Promise<VoiceboxHistoryResult> {
    const pollIntervalMs = clampInt(args.pollIntervalMs ?? 1_500, 300, 10_000);
    const maxWaitMs = clampInt(args.maxWaitMs ?? 120_000, 5_000, 600_000);
    const startedAt = Date.now();

    while (Date.now() - startedAt <= maxWaitMs) {
      const status = await this.getHistory(args.generationId);
      if (status.status === "completed") return status;
      if (status.status === "failed") return status;
      await sleep(pollIntervalMs);
    }

    throw new Error(`voicebox generation timeout after ${maxWaitMs}ms`);
  }

  async downloadAudio(generationId: string): Promise<Buffer> {
    const safeId = encodeURIComponent(generationId);
    const response = await this.fetchBinary(`/audio/${safeId}`, { method: "GET" });
    if (!response.ok) {
      throw new Error(`voicebox audio download failed: ${response.status} ${response.bodyText}`);
    }
    return response.data;
  }

  private async fetchJson(
    route: string,
    init: RequestInit
  ): Promise<{ ok: boolean; status: number; data: unknown; bodyText: string }> {
    const response = await fetchWithTimeout(joinUrl(this.baseUrl, route), init, this.requestTimeoutMs);
    const bodyText = await response.text();
    let data: unknown = null;
    if (bodyText) {
      try {
        data = JSON.parse(bodyText);
      } catch {
        data = null;
      }
    }
    return { ok: response.ok, status: response.status, data, bodyText };
  }

  private async fetchBinary(
    route: string,
    init: RequestInit
  ): Promise<{ ok: boolean; status: number; data: Buffer; bodyText: string }> {
    const response = await fetchWithTimeout(joinUrl(this.baseUrl, route), init, this.requestTimeoutMs);
    const bytes = Buffer.from(await response.arrayBuffer());
    const bodyText = response.ok ? "" : bytes.toString("utf-8");
    return {
      ok: response.ok,
      status: response.status,
      data: bytes,
      bodyText
    };
  }
}

function joinUrl(base: string, route: string): string {
  return `${base}${route.startsWith("/") ? route : `/${route}`}`;
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = compactText(raw);
  if (!trimmed) return "";
  return trimmed.replace(/\/+$/, "");
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}
