import { serve } from "bun";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { PERSONA_CONTACTS_DIR, PERSONA_GROUPS_DIR } from "../config.js";
import { GeminiClient } from "../gemini.js";
import { listGeminiModelsForGenerateContent } from "../gemini-models.js";
import { loadConfig, loadEnv, saveConfig } from "../config.js";
import { loadPersonaContext, personaPaths } from "../persona.js";
import { suggestPersonaFromTranscript } from "../persona-suggestions.js";
import {
  deleteChatHistoryFile,
  readAllChatHistories,
  readChatHistoryRaw,
  readDebugLogEvents
} from "../storage.js";
import { getUnauthorizedCandidates, removeUnauthorizedCandidate } from "../unauthorized.js";
import {
  ackClaudeEvents,
  listPendingClaudeEvents,
  MEDIA_INBOX_DIR
} from "../claude-bridge.js";
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
    // Local-only: the API can send WhatsApp messages (claude/send), so never expose it on the LAN.
    hostname: "127.0.0.1",
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
            // --- Claude mediator bridge (see CLAUDE.md → "WhatsApp Mediator Protocol") ---
            case "claude/status": {
                const cfg = loadConfig();
                const snapshot = runtime.getUiSessionSnapshot();
                return Response.json({
                  mediatorEnabled: cfg.claudeMediatorEnabled,
                  mediatorExclusive: cfg.claudeMediatorExclusive,
                  mediatorChats: cfg.claudeMediatorChats,
                  connected: snapshot.whatsappConnected,
                  connection: snapshot.whatsappConnection,
                  ownJid: runtime.getOwnJid(),
                  pendingCount: listPendingClaudeEvents().length
                });
            }
            case "claude/pending":
                return Response.json(listPendingClaudeEvents());
            case "claude/chat": {
                const jid = url.searchParams.get("jid")?.trim() ?? "";
                if (!jid) {
                  return Response.json({ error: "jid query param required" }, { status: 400 });
                }
                const limitRaw = url.searchParams.get("limit");
                const limit = Math.min(
                  500,
                  Math.max(1, Number.parseInt(limitRaw ?? "50", 10) || 50)
                );
                return Response.json({ jid, messages: readChatHistoryRaw(jid).slice(-limit) });
            }
            case "claude/context": {
                // Full reply context in one call: persona rules + chat history + app memory
                // (contact scope AND owner scope). This is what mediator subagents consume.
                const jid = url.searchParams.get("jid")?.trim() ?? "";
                if (!jid) {
                  return Response.json({ error: "jid query param required" }, { status: 400 });
                }
                const senderJid = url.searchParams.get("senderJid")?.trim() || jid;
                const query = url.searchParams.get("query")?.trim() || "general";
                const historyLimit = Math.min(
                  200,
                  Math.max(5, Number.parseInt(url.searchParams.get("limit") ?? "30", 10) || 30)
                );
                const isGroup = jid.endsWith("@g.us");
                const cfg = loadConfig();
                const memoryLimit = Math.max(5, cfg.memoryTopK * 2);
                const [memories, ownerMemories] = await Promise.all([
                  runtime.retrieveMemoriesForClaude(senderJid, query, memoryLimit).catch(() => []),
                  runtime.retrieveOwnerMemoriesForClaude(query, memoryLimit).catch(() => [])
                ]);
                return Response.json({
                  jid,
                  senderJid,
                  isGroup,
                  persona: loadPersonaContext({ chatJid: jid, senderJid, isGroup }),
                  history: readChatHistoryRaw(jid).slice(-historyLimit),
                  memories,
                  ownerMemories
                });
            }
            case "claude/transcribe-media": {
                const file = url.searchParams.get("file")?.trim() ?? "";
                if (!file || file.includes("/") || file.includes("\\") || file.includes("..")) {
                  return Response.json({ error: "file must be a bare filename from data/media/" }, { status: 400 });
                }
                const mediaPath = join(MEDIA_INBOX_DIR, file);
                if (!existsSync(mediaPath)) {
                  return Response.json({ error: "file not found" }, { status: 404 });
                }
                try {
                  const env = loadEnv();
                  const { GeminiClient } = await import("../gemini.js");
                  const { transcribeAudio } = await import("../transcribe.js");
                  const gemini = new GeminiClient(env.geminiApiKey);
                  const bytes = readFileSync(mediaPath);
                  const ext = mediaPath.split(".").pop()?.toLowerCase() ?? "";
                  const mimeMap: Record<string, string> = {
                    ogg: "audio/ogg", mp3: "audio/mpeg", mp4: "audio/mp4",
                    m4a: "audio/mp4", wav: "audio/wav", webm: "audio/webm"
                  };
                  const mimeType = mimeMap[ext] ?? "audio/ogg";
                  const cfg = loadConfig();
                  let usedProvider = "unknown";
                  const transcript = await transcribeAudio(bytes as Buffer, mimeType, {
                    env,
                    gemini,
                    geminiModel: cfg.model,
                    onLog: (p) => { usedProvider = p; }
                  });
                  return Response.json({ file, mimeType, transcript, provider: usedProvider });
                } catch (err: unknown) {
                  const msg = err instanceof Error ? err.message : String(err);
                  return Response.json({ error: msg }, { status: 502 });
                }
            }
            case "claude/media": {
                const file = url.searchParams.get("file")?.trim() ?? "";
                if (!file || file.includes("/") || file.includes("\\") || file.includes("..")) {
                  return Response.json(
                    { error: "file query param must be a bare filename from data/media/" },
                    { status: 400 }
                  );
                }
                const mediaPath = join(MEDIA_INBOX_DIR, file);
                if (!existsSync(mediaPath)) {
                  return Response.json({ error: "media file not found" }, { status: 404 });
                }
                return new Response(readFileSync(mediaPath), {
                  headers: { "Content-Type": "application/octet-stream" }
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
                const raw = await req.text();
                let body: Record<string, unknown> = {};
                if (raw.trim()) {
                  const parsed = JSON.parse(raw) as unknown;
                  body =
                    parsed && typeof parsed === "object" && !Array.isArray(parsed)
                      ? (parsed as Record<string, unknown>)
                      : {};
                }
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
                      const fullReset = body.fullReset === true;
                      if (fullReset) {
                        await runtime.factoryResetAndReconnect();
                      } else {
                        await runtime.resetAuthFolderAndReconnect();
                      }
                      return Response.json({ success: true });
                    }
                    case "session/full-reset": {
                      await runtime.factoryResetAndReconnect();
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
                    // --- Claude mediator bridge ---
                    case "claude/send": {
                        const to = typeof body.to === "string" ? body.to.trim() : "";
                        const text = typeof body.text === "string" ? body.text : "";
                        if (!to || !text.trim()) {
                          return Response.json(
                            { error: "body must include 'to' (jid or phone) and 'text'" },
                            { status: 400 }
                          );
                        }
                        const sent = await runtime.sendMediatedText(to, text);
                        return Response.json({ success: true, ...sent });
                    }
                    case "claude/send-file": {
                        const to = typeof body.to === "string" ? body.to.trim() : "";
                        const filePath = typeof body.path === "string" ? body.path.trim() : "";
                        if (!to || !filePath) {
                          return Response.json(
                            { error: "body must include 'to' and 'path' (absolute local file path)" },
                            { status: 400 }
                          );
                        }
                        if (!existsSync(filePath)) {
                          return Response.json({ error: "file not found" }, { status: 404 });
                        }
                        const sentFile = await runtime.sendMediatedFile({
                          to,
                          absolutePath: filePath,
                          fileName: typeof body.fileName === "string" ? body.fileName : undefined,
                          caption: typeof body.caption === "string" ? body.caption : undefined
                        });
                        return Response.json({ success: true, ...sentFile });
                    }
                    case "claude/ack": {
                        const ids = Array.isArray(body.ids)
                          ? body.ids.filter((id): id is string => typeof id === "string")
                          : [];
                        if (ids.length === 0) {
                          return Response.json(
                            { error: "body must include non-empty string array 'ids'" },
                            { status: 400 }
                          );
                        }
                        const acked = ackClaudeEvents(ids);
                        return Response.json({
                          success: true,
                          acked,
                          pendingCount: listPendingClaudeEvents().length
                        });
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

      const staticContentType = (target: string): string => {
        if (target.endsWith(".js")) return "application/javascript";
        if (target.endsWith(".css")) return "text/css";
        if (target.endsWith(".html")) return "text/html";
        if (target.endsWith(".svg")) return "image/svg+xml";
        if (target.endsWith(".png")) return "image/png";
        if (target.endsWith(".ico")) return "image/x-icon";
        if (target.endsWith(".woff2")) return "font/woff2";
        if (target.endsWith(".woff")) return "font/woff";
        if (target.endsWith(".json")) return "application/json";
        return "text/plain";
      };

      try {
        const fileData = readFileSync(filePath);
        const contentType = staticContentType(filePath);
        return new Response(fileData, {
          headers: {
            "Content-Type": contentType,
            // index.html must never be cached — its hashed asset refs go stale after rebuilds
            // (a cached old index.html requesting missing assets renders a blank page).
            "Cache-Control": contentType === "text/html" ? "no-cache" : "public, max-age=31536000, immutable"
          }
        });
      } catch (e) {
        // Hashed assets must 404 when missing — serving the SPA fallback here makes the
        // browser execute HTML as a JS module and the page silently renders blank.
        if (url.pathname.startsWith("/assets/")) {
          return new Response("Not Found", { status: 404 });
        }
        // Fallback for SPA routes (/dashboard, /actions, ...)
        try {
            const indexData = readFileSync(resolve(distDir, "index.html"));
            return new Response(indexData, {
              headers: { "Content-Type": "text/html", "Cache-Control": "no-cache" }
            });
        } catch(fallbackErr) {
            return new Response("Web UI not built. Run `bun run ui:build`.", { status: 404 });
        }
      }
    }
  });

  console.log(`[Talky Web UI] Started on http://localhost:${server.port}`);
}
