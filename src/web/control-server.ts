import { serve } from "bun";
import { resolve } from "path";
import { readFileSync, writeFileSync } from "fs";
import { WhatsAppAgent } from "../whatsapp.js";
import { loadConfig, saveConfig } from "../config.js";
import { personaPaths } from "../persona.js";
import { readAllChatHistories, readDebugLogEvents } from "../storage.js";
import { getUnauthorizedCandidates, removeUnauthorizedCandidate } from "../unauthorized.js";

const DEFAULT_PORT = process.env.WEB_UI_PORT ? parseInt(process.env.WEB_UI_PORT) : 4173;

export function startControlServer(runtime: WhatsAppAgent) {
  const server = serve({
    port: DEFAULT_PORT,
    async fetch(req: Request) {
      const url = new URL(req.url);
      
      // API Routes
      if (url.pathname.startsWith("/api/")) {
        const path = url.pathname.replace("/api/", "");

        if (req.method === "GET") {
          switch (path) {
            case "status":
                return Response.json({ status: "running", port: DEFAULT_PORT });
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
          }
        }

        if (req.method === "POST" && req.body) {
            try {
                const body = await req.json();
                switch (path) {
                    case "config": {
                        const current = loadConfig();
                        const newConfig = { ...current, ...body };
                        saveConfig(newConfig);
                        runtime.updateConfig(newConfig);
                        return Response.json({ success: true, config: newConfig });
                    }
                    case "unauthorized/resolve": {
                        const { jid, action, listType } = body;
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
                        if (body.soul !== undefined) writeFileSync(paths.soul, body.soul, "utf-8");
                        if (body.communicationRules !== undefined) writeFileSync(paths.communicationRules, body.communicationRules, "utf-8");
                        if (body.recentMemory !== undefined) writeFileSync(paths.recentMemory, body.recentMemory, "utf-8");
                        return Response.json({ success: true });
                    }
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
