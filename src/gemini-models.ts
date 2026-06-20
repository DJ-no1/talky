/** List models available to the API key that support text generation (`generateContent`). */

export type GeminiModelListItem = {
  id: string;
  displayName: string;
};

type ListModelsPage = {
  models?: Array<{
    name?: string;
    displayName?: string;
    supportedGenerationMethods?: string[];
  }>;
  nextPageToken?: string;
};

export async function listGeminiModelsForGenerateContent(
  apiKey: string
): Promise<GeminiModelListItem[]> {
  const out: GeminiModelListItem[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    url.searchParams.set("key", apiKey);
    url.searchParams.set("pageSize", "100");
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }

    const res = await fetch(url.toString());
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `Gemini list models failed (${res.status}): ${text.slice(0, 400)}${text.length > 400 ? "…" : ""}`
      );
    }

    let data: ListModelsPage;
    try {
      data = JSON.parse(text) as ListModelsPage;
    } catch {
      throw new Error("Gemini list models: invalid JSON response");
    }

    for (const m of data.models ?? []) {
      const methods = m.supportedGenerationMethods ?? [];
      if (!methods.includes("generateContent")) {
        continue;
      }
      const name = (m.name ?? "").trim();
      const id = name.startsWith("models/") ? name.slice("models/".length) : name;
      if (!id) {
        continue;
      }
      const displayName = (m.displayName ?? "").trim() || id;
      out.push({ id, displayName });
    }

    pageToken = data.nextPageToken;
  } while (pageToken);

  out.sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" })
  );
  return out;
}
