import { serve } from "bun";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { PERSONA_CONTACTS_DIR, PERSONA_GROUPS_DIR } from "../config.js";
import { GeminiClient } from "../gemini.js";
import { listGeminiModelsForGenerateContent } from "../gemini-models.js";
import { loadConfig, loadEnv, saveConfig } from "../config.js";
import { personaPaths } from "../persona.js";
import { suggestPersonaFromTranscript } from "../persona-suggestions.js";
import { deleteChatHistoryFile, readAllChatHistories, readDebugLogEvents } from "../storage.js";
import { getUnauthorizedCandidates, removeUnauthorizedCandidate } from "../unauthorized.js";
import { WhatsAppAgent } from "../whatsapp.js";

const DEFAULT_PORT = process.env.WEB_UI_PORT ? parseInt(process.env.WEB_UI_PORT) : 4173;

function listPersonaMarkdownStemPreviews(
  dir: string
): Array<{ stem: string; preview: string }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const stem = f.replace(/\.md$/, "");
      const raw = readFileSync(join(dir, f), "utf-8").trim();
      const preview = raw.replace(/\s+/g, " ").slice(0, 240);
      return { stem, preview };
    })
    .sort((a, b) => a.stem.localeCompare(b.stem));
}

function readPersonaProfileFile(kind: "contact" | "group", stem: string): string {
  const safe = stem.replace(/\.md$/i, "").trim();
  const dir = kind === "contact" ? PERSONA_CONTACTS_DIR : PERSONA_GROUPS_DIR;
  const filePath = join(dir, `${safe}.md`);
  if (!existsSync(filePath)) return "";
  return readFileSync(filePath, "utf-8");
}

function writePersonaProfileFile(kind: "contact" | "group", stem: string, content: string): void {
  const safe = stem.replace(/\.md$/i, "").trim();
  if (!safe || safe.includes("..") || safe.includes("/") || safe.includes("\\")) {
    throw new Error("invalid profile stem");
  }
  const dir = kind === "contact" ? PERSONA_CONTACTS_DIR : PERSONA_GROUPS_DIR;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${safe}.md`), content, "utf-8");
}

export function startControlServer(runtime: WhatsAppAgent) {
  const server = serve({
    port: DEFAULT_PORT,
    async fetch(req: Request) {
      const url = new URL(req.url);
      
      // API Routes
      if (url.pathname.startsWith("/api")) {
        const path =
          url.pathname
            .replace(/^\/api\/?/, "")
            .replace(/\/+$/, "") || "";

        if (req.method === "GET") {
          switch (path) {
            case "status":
                return Response.json({
                  status: "running",
                  port: DEFAULT_PORT,
                  ...runtime.getUiSessionSnapshot(),
                });
            case "config":
                return Response.json(loadConfig());
            case "unauthorized":
                return Response.json(getUnauthorizedCandidates());
                        case "groups": {
                                const forceRefresh = url.searchParams.get("refresh") === "1";
                                try {
                                    return Response.json(await runtime.getGroups(forceRefresh));
                                } catch {
                                    return Response.json([]);
                                }
                        }
            case "chats":
                return Response.json(readAllChatHistories());
            case "logs/events": {
                const chatJid = url.searchParams.get("chatJid") ?? undefined;
                const limitRaw = url.searchParams.get("limit");
                const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
                return Response.json(readDebugLogEvents({ chatJid, limit }));
            }
            case "persona": {
                const paths = personaPaths();
                return Response.json({
                  soul: readFileSync(paths.soul, "utf-8"),
                  communicationRules: readFileSync(paths.communicationRules, "utf-8"),
                  recentMemory: readFileSync(paths.recentMemory, "utf-8")
                });
            }
            case "persona/profiles": {
                return Response.json({
                  contacts: listPersonaMarkdownStemPreviews(PERSONA_CONTACTS_DIR),
                  groups: listPersonaMarkdownStemPreviews(PERSONA_GROUPS_DIR)
                });
            }
            case "persona/profile": {
                const stem = url.searchParams.get("stem") ?? "";
                const kind = url.searchParams.get("kind") ?? "";
                if (!stem || (kind !== "contact" && kind !== "group")) {
                  return Response.json(
                    { error: "Query params stem and kind=contact|group are required" },
                    { status: 400 }
                  );
                }
                return Response.json({
                  stem,
                  kind,
                  content: readPersonaProfileFile(kind, stem)
                });
            }
            case "models": {
                try {
                  const env = loadEnv();
                  const models = await listGeminiModelsForGenerateContent(env.geminiApiKey);
                  return Response.json({
                    models,
                    currentModel: loadConfig().model
                  });
                } catch (err: unknown) {
                  const message = err instanceof Error ? err.message : String(err);
                  return Response.json({ error: message }, { status: 502 });
                }
            }
          }
        }

        if (req.method === "DELETE") {
          try {
            if (path === "chats") {
              const jid = url.searchParams.get("jid")?.trim() ?? "";
              if (!jid) {
                return Response.json({ error: "jid required" }, { status: 400 });
              }
              try {
                const removed = deleteChatHistoryFile(jid);
                return Response.json({ success: true, removed });
              } catch (unlinkErr: unknown) {
                const message = unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr);
                return Response.json(
                  { success: false, error: `Could not remove chat file: ${message}` },
                  { status: 500 }
                );
              }
            }
          } catch (err: unknown) {
            return Response.json(
              { success: false, error: err instanceof Error ? err.message : String(err) },
              { status: 500 }
            );
          }
        }

        if (req.method === "POST") {
            try {
                const body = await req.json() as Record<string, unknown>;
                switch (path) {
                    case "config": {
                        const current = loadConfig();
                        const newConfig = { ...current, ...body };
                        saveConfig(newConfig);
                        runtime.updateConfig(newConfig);
                        return Response.json({ success: true, config: newConfig });
                    }
                    case "unauthorized/resolve": {
                        const jid = typeof body.jid === "string" ? body.jid : "";
                        const action = typeof body.action === "string" ? body.action : "";
                        const listType = typeof body.listType === "string" ? body.listType : "";
                        if (action === "allow") {
                            const config = loadConfig();
                            if (listType === "direct") {
                                if (!config.allowedDirectJids.includes(jid)) config.allowedDirectJids.push(jid);
                            } else {
                                if (!config.allowedGroupJids.includes(jid)) config.allowedGroupJids.push(jid);
                            }
                            saveConfig(config);
                            runtime.updateConfig(config);
                        }
                        removeUnauthorizedCandidate(jid);
                        return Response.json({ success: true });
                    }
                    case "session/repair": {
                        await runtime.repairSession();
                        return Response.json({ success: true });
                    }
                    case "session/relink": {
                        await runtime.relinkSession();
                        return Response.json({ success: true });
                    }
                    case "persona": {
                        const paths = personaPaths();
                        if (typeof body.soul === "string") writeFileSync(paths.soul, body.soul, "utf-8");
                        if (typeof body.communicationRules === "string")
                          writeFileSync(paths.communicationRules, body.communicationRules, "utf-8");
                        if (typeof body.recentMemory === "string")
                          writeFileSync(paths.recentMemory, body.recentMemory, "utf-8");
                        return Response.json({ success: true });
                    }
                    case "chats/delete": {
                        const jid = typeof body.jid === "string" ? body.jid.trim() : "";
                        if (!jid) {
                          return Response.json({ error: "jid required" }, { status: 400 });
                        }
                        try {
                          const removed = deleteChatHistoryFile(jid);
                          return Response.json({ success: true, removed });
                        } catch (unlinkErr: unknown) {
                          const message = unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr);
                          return Response.json(
                            { success: false, error: `Could not remove chat file: ${message}` },
                            { status: 500 }
                          );
                        }
                    }
                    case "persona/profile": {
                        const kind = body.kind;
                        const stem = body.stem;
                        if (kind !== "contact" && kind !== "group") {
                          return Response.json({ error: "kind must be contact or group" }, { status: 400 });
                        }
                        if (typeof stem !== "string" || !stem.trim()) {
                          return Response.json({ error: "stem required" }, { status: 400 });
                        }
                        writePersonaProfileFile(
                          kind,
                          stem,
                          typeof body.content === "string" ? body.content : ""
                        );
                        return Response.json({ success: true });
                    }
                    case "persona/suggest-from-chat": {
                        const env = loadEnv();
                        if (!env.geminiApiKey) {
                          return Response.json({ error: "GOOGLE_GENERATIVE_AI_API_KEY not set" }, { status: 503 });
                        }
                        const cfg = loadConfig();
                        const transcript = typeof body.transcript === "string" ? body.transcript : "";
                        const target = body.target as string | undefined;
                        const map = {
                          soul: "soul" as const,
                          communicationRules: "communicationRules" as const,
                          recentMemory: "recentMemory" as const
                        };
                        const t =
                          target === "communicationRules" || target === "recentMemory" || target === "soul"
                            ? map[target]
                            : "recentMemory";
                        const currentSoul = typeof body.currentSoul === "string" ? body.currentSoul : "";
                        const currentRules =
                          typeof body.currentCommunicationRules === "string"
                            ? body.currentCommunicationRules
                            : "";
                        const currentRecent =
                          typeof body.currentRecentMemory === "string" ? body.currentRecentMemory : "";
                        const currentSection =
                          t === "soul" ? currentSoul : t === "communicationRules" ? currentRules : currentRecent;

                        const client = new GeminiClient(env.geminiApiKey);
                        const suggestion = await suggestPersonaFromTranscript(client, cfg.model, {
                          transcript,
                          target: t,
                          currentSection
                        });
                        return Response.json({ suggestion });
                    }
                    default:
                        return Response.json(
                            { error: "Unknown POST route", path },
                            { status: 404 }
                        );
                }
            } catch (err: any) {
                return Response.json({ success: false, error: String(err) }, { status: 400 });
            }
        }
        
        return new Response("Not Found", { status: 404 });
      }

      // Serve UI builds (fallback to index.html for SPA)
      const distDir = resolve(process.cwd(), "web-ui", "dist");
      let filePath = resolve(distDir, url.pathname === "/" ? "index.html" : url.pathname.slice(1));
      
      try {
        const fileData = readFileSync(filePath);
        const contentType = filePath.endsWith(".js") ? "application/javascript" :
                            filePath.endsWith(".css") ? "text/css" :
                            filePath.endsWith(".html") ? "text/html" :
                            "text/plain";

        return new Response(fileData, { headers: { "Content-Type": contentType } });
      } catch (e) {
        // Fallback for SPA
        try {
            const indexData = readFileSync(resolve(distDir, "index.html"));
            return new Response(indexData, { headers: { "Content-Type": "text/html" } });
        } catch(fallbackErr) {
            return new Response("Web UI not built. Run `bun run ui:build`.", { status: 404 });
        }
      }
    }
  });

  console.log(`[Talky Web UI] Started on http://localhost:${server.port}`);
}
