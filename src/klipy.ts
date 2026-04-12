import { compactText } from "./utils";

export type KlipyContentFilter = "off" | "low" | "medium" | "high";

export type KlipyGifSearchArgs = {
  query: string;
  customerId: string;
  locale?: string;
  contentFilter?: KlipyContentFilter;
  page?: number;
  perPage?: number;
};

export type KlipyGifAsset = {
  url: string;
  width?: number;
  height?: number;
  size?: number;
};

export type KlipyGifItem = {
  id: string;
  slug: string;
  title: string;
  type?: string;
  mp4?: KlipyGifAsset;
  gif?: KlipyGifAsset;
  webm?: KlipyGifAsset;
};

export type KlipyGifSearchResult = {
  items: KlipyGifItem[];
  picked?: KlipyGifItem;
};

const KLIPY_BASE_URL = "https://api.klipy.com";

export class KlipyClient {
  constructor(private readonly appKey: string) {}

  async searchGifs(args: KlipyGifSearchArgs): Promise<KlipyGifSearchResult> {
    const query = compactText(args.query);
    const customerId = compactText(args.customerId);
    if (!query) {
      throw new Error("query is required");
    }
    if (!customerId) {
      throw new Error("customerId is required");
    }

    const page = clampInt(args.page ?? 1, 1, 200);
    const perPage = clampInt(args.perPage ?? 8, 1, 20);
    const locale = normalizeLocale(args.locale);
    const contentFilter = normalizeContentFilter(args.contentFilter);

    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("per_page", String(perPage));
    params.set("q", query);
    params.set("customer_id", customerId);
    params.set("locale", locale);
    params.set("content_filter", contentFilter);
    params.set("format_filter", "mp4,gif,webm");

    const url = `${KLIPY_BASE_URL}/api/v1/${encodeURIComponent(this.appKey)}/gifs/search?${params.toString()}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Klipy GIF search failed (${response.status}): ${detail}`);
    }

    const payload = (await response.json()) as unknown;
    const rawItems = readRawItems(payload);
    const items = rawItems
      .map((item) => toKlipyGifItem(item))
      .filter((item): item is KlipyGifItem => Boolean(item));

    return {
      items,
      picked: pickBestGifItem(items)
    };
  }
}

function readRawItems(payload: unknown): unknown[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== "object") return [];
  const rows = (data as { data?: unknown }).data;
  if (!Array.isArray(rows)) return [];
  return rows;
}

function toKlipyGifItem(value: unknown): KlipyGifItem | null {
  if (!value || typeof value !== "object") return null;
  const row = value as {
    id?: number | string;
    slug?: string;
    title?: string;
    type?: string;
    file?: Record<string, unknown>;
  };

  const slug = compactText(String(row.slug ?? ""));
  const id = compactText(String(row.id ?? ""));
  if (!slug && !id) return null;

  if (compactText(String(row.type ?? "")).toLowerCase() === "ad") {
    return null;
  }

  const preferredSizes = ["sm", "md", "xs", "hd"];
  const mp4 = pickAsset(row.file, preferredSizes, "mp4");
  const gif = pickAsset(row.file, preferredSizes, "gif");
  const webm = pickAsset(row.file, preferredSizes, "webm");

  if (!mp4 && !gif && !webm) return null;

  return {
    id: id || slug,
    slug: slug || id,
    title: compactText(String(row.title ?? "")) || slug || id,
    type: compactText(String(row.type ?? "")) || undefined,
    mp4,
    gif,
    webm
  };
}

function pickAsset(
  file: Record<string, unknown> | undefined,
  sizes: string[],
  format: "mp4" | "gif" | "webm"
): KlipyGifAsset | undefined {
  if (!file || typeof file !== "object") return undefined;

  for (const size of sizes) {
    const sizeNode = file[size];
    if (!sizeNode || typeof sizeNode !== "object") continue;

    const formatNode = (sizeNode as Record<string, unknown>)[format];
    if (!formatNode || typeof formatNode !== "object") continue;

    const url = compactText(String((formatNode as { url?: unknown }).url ?? ""));
    if (!url) continue;

    const width = asOptionalNumber((formatNode as { width?: unknown }).width);
    const height = asOptionalNumber((formatNode as { height?: unknown }).height);
    const sizeBytes = asOptionalNumber((formatNode as { size?: unknown }).size);

    return {
      url,
      width,
      height,
      size: sizeBytes
    };
  }

  return undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function pickBestGifItem(items: KlipyGifItem[]): KlipyGifItem | undefined {
  if (items.length === 0) return undefined;

  // Prefer entries with mp4 so WhatsApp can send it as gifPlayback video.
  const withMp4 = items.filter((item) => Boolean(item.mp4?.url));
  if (withMp4.length > 0) {
    return withMp4[0];
  }

  return items[0];
}

function normalizeLocale(locale: string | undefined): string {
  const raw = compactText(locale ?? "").toLowerCase();
  if (/^[a-z]{2}$/.test(raw)) return raw;
  return "us";
}

function normalizeContentFilter(value: KlipyContentFilter | undefined): KlipyContentFilter {
  const raw = compactText(value ?? "").toLowerCase();
  if (raw === "off" || raw === "low" || raw === "medium" || raw === "high") {
    return raw;
  }
  return "low";
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
