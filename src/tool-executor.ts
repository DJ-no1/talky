import path from "node:path";
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import type {
  AppConfig,
  GeminiToolCall,
  GeminiToolDeclaration,
  ToolExecutionResult
} from "./types";
import {
  appendToolActionLog,
  isShareTargetAllowed,
  listLocalFilesTool,
  readLocalFileTool,
  resolveAllowedPath
} from "./tools";
import { compactText } from "./utils";

export type ToolRuntimeContext = {
  config: AppConfig;
  currentChatJid: string;
  currentSenderJid: string;
  availableToolNames?: string[];
  sendFile: (args: {
    chatJid: string;
    absolutePath: string;
    fileName?: string;
    caption?: string;
  }) => Promise<void>;
  sendStickerByQuery: (args: {
    chatJid: string;
    query?: string;
  }) => Promise<{ ok: boolean; message: string; source?: string }>;
  sendKlipyGifByQuery: (args: {
    chatJid: string;
    query: string;
    customerId?: string;
    locale?: string;
    contentFilter?: "off" | "low" | "medium" | "high";
    perPage?: number;
  }) => Promise<{
    ok: boolean;
    message: string;
    data?: {
      slug?: string;
      title?: string;
      query?: string;
      mediaUrl?: string;
      mediaFormat?: "mp4" | "gif" | "webm";
    };
  }>;
  sendVoiceReply: (args: {
    chatJid: string;
    text: string;
    voice?: string;
    language?: string;
    speed?: number;
    speaker1Name?: string;
    speaker1Voice?: string;
    speaker2Name?: string;
    speaker2Voice?: string;
  }) => Promise<{
    ok: boolean;
    message: string;
    data?: {
      provider?: string;
      voice?: string;
      language?: string;
      speed?: number;
      model?: string;
      multiSpeaker?: boolean;
    };
  }>;
  sendImageReply: (args: {
    chatJid: string;
    prompt: string;
    caption?: string;
    width?: number;
    height?: number;
    style?: "image" | "meme" | "quote_card";
  }) => Promise<{
    ok: boolean;
    message: string;
    data?: { imageUrl?: string; prompt?: string; style?: string };
  }>;
  sendTextMessage: (args: { chatJid: string; text: string }) => Promise<void>;
};

export function buildToolDeclarations(
  config: AppConfig,
  options?: { enableKlipyGif?: boolean }
): GeminiToolDeclaration[] {
  if (!config.toolCallingEnabled) return [];

  const tools: GeminiToolDeclaration[] = [
    {
      name: "list_available_tools",
      description:
        "Return the exact tool names currently available in this runtime. Use this when user asks what tools/functions can be called.",
      parameters: {
        type: "object",
        properties: {}
      }
    },
    {
      name: "list_local_files",
      description:
        "List files and folders under an allowed local path. Use this before selecting files to read or share.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or workspace-relative path" },
          recursive: { type: "boolean", description: "Whether to traverse subfolders" },
          limit: { type: "integer", description: "Maximum entries to return (1-300)" },
          maxDepth: { type: "integer", description: "Recursion depth limit (0-8)" }
        },
        required: ["path"]
      }
    },
    {
      name: "read_local_file",
      description:
        "Read a local file from an allowed path for analysis. Large files may be truncated and binary files are base64 encoded.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or workspace-relative file path" },
          maxBytes: {
            type: "integer",
            description: "Optional byte cap for output, up to maxToolReadFileBytes"
          }
        },
        required: ["path"]
      }
    },
    {
      name: "share_local_file",
      description:
        "Share local file(s) to WhatsApp. If path is a file, send that file; if path is a folder, send up to maxFiles from it.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or workspace-relative file/folder path"
          },
          targetChatJid: {
            type: "string",
            description: "Optional destination chat JID; defaults to current chat"
          },
          caption: { type: "string", description: "Optional caption" },
          maxFiles: {
            type: "integer",
            description: "When path is a folder, max files to send (1-12, default 4)"
          }
        },
        required: ["path"]
      }
    },
    {
      name: "send_sticker",
      description:
        "Send a sticker reply using either recent incoming stickers or local sticker pack files.",
      parameters: {
        type: "object",
        properties: {
          targetChatJid: {
            type: "string",
            description: "Optional destination chat JID; defaults to current chat"
          },
          query: {
            type: "string",
            description: "Optional keyword to pick a matching sticker from local pack"
          }
        }
      }
    },
    {
      name: "send_voice_reply",
      description:
        "Turn text into a WhatsApp voice note (PTT style) using Gemini TTS. Supports optional two-speaker rendering.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to speak" },
          targetChatJid: {
            type: "string",
            description: "Optional destination chat JID; defaults to current chat"
          },
          voice: {
            type: "string",
            description: "Optional primary Gemini prebuilt voice name (e.g. Kore, Puck)"
          },
          language: { type: "string", description: "Optional language code (e.g. en, bn, hi)" },
          speed: { type: "number", description: "Optional speech speed (0.5 to 1.6)" },
          speaker1Name: {
            type: "string",
            description: "Optional first speaker name when doing multi-speaker TTS"
          },
          speaker1Voice: {
            type: "string",
            description: "Optional voice for speaker1 (defaults to voice or Kore)"
          },
          speaker2Name: {
            type: "string",
            description: "Optional second speaker name for multi-speaker TTS"
          },
          speaker2Voice: {
            type: "string",
            description: "Optional voice for speaker2 (defaults to Puck)"
          }
        },
        required: ["text"]
      }
    },
    {
      name: "send_image_reply",
      description:
        "Generate and send an image from prompt context.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Image generation prompt" },
          targetChatJid: {
            type: "string",
            description: "Optional destination chat JID; defaults to current chat"
          },
          caption: { type: "string", description: "Optional image caption" },
          width: { type: "integer", description: "Optional width (512-1536)" },
          height: { type: "integer", description: "Optional height (512-1536)" }
        },
        required: ["prompt"]
      }
    },
    {
      name: "send_meme_reply",
      description:
        "Create and send a meme-style image from message sentiment/context.",
      parameters: {
        type: "object",
        properties: {
          sourceText: { type: "string", description: "Context text to convert into meme" },
          tone: { type: "string", description: "Optional tone (funny, savage, wholesome, etc.)" },
          targetChatJid: {
            type: "string",
            description: "Optional destination chat JID; defaults to current chat"
          }
        },
        required: ["sourceText"]
      }
    },
    {
      name: "send_styled_quote_card",
      description:
        "Render and send a stylish quote card image for cool replies.",
      parameters: {
        type: "object",
        properties: {
          quote: { type: "string", description: "Quote text to render" },
          author: { type: "string", description: "Optional author/tagline" },
          targetChatJid: {
            type: "string",
            description: "Optional destination chat JID; defaults to current chat"
          }
        },
        required: ["quote"]
      }
    },
    {
      name: "send_voice_plus_text",
      description:
        "Send a voice note and a short text fallback/companion message.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to speak in voice note" },
          fallbackText: { type: "string", description: "Optional short text sent after voice" },
          targetChatJid: {
            type: "string",
            description: "Optional destination chat JID; defaults to current chat"
          },
          voice: {
            type: "string",
            description: "Optional primary Gemini prebuilt voice name (e.g. Kore, Puck)"
          },
          language: { type: "string", description: "Optional language code" },
          speed: { type: "number", description: "Optional speech speed" },
          speaker1Name: {
            type: "string",
            description: "Optional first speaker name for multi-speaker mode"
          },
          speaker1Voice: {
            type: "string",
            description: "Optional voice for speaker1 (defaults to voice or Kore)"
          },
          speaker2Name: {
            type: "string",
            description: "Optional second speaker name for multi-speaker mode"
          },
          speaker2Voice: {
            type: "string",
            description: "Optional voice for speaker2 (defaults to Puck)"
          }
        },
        required: ["text"]
      }
    },
    {
      name: "send_reaction_combo",
      description:
        "Choose and send the best reaction mode (sticker, GIF, or voice) based on tone/context.",
      parameters: {
        type: "object",
        properties: {
          sourceText: { type: "string", description: "Context or user text to react to" },
          tone: { type: "string", description: "Optional mood/tone hint" },
          preferredMode: {
            type: "string",
            enum: ["auto", "sticker", "gif", "voice"],
            description: "Optional explicit reaction mode"
          },
          targetChatJid: {
            type: "string",
            description: "Optional destination chat JID; defaults to current chat"
          }
        }
      }
    }
  ];

  if (options?.enableKlipyGif) {
    tools.push({
      name: "send_gif",
      description:
        "Search KLIPY GIF API by query and send one relevant GIF back to chat. Short alias of send_klipy_gif for easier calling.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Keyword phrase for GIF search, e.g. happy dance, angry reaction, facepalm"
          },
          targetChatJid: {
            type: "string",
            description: "Optional destination chat JID; defaults to current chat"
          },
          customerId: {
            type: "string",
            description:
              "Optional stable user id for personalization/analytics; defaults to current sender"
          },
          locale: {
            type: "string",
            description: "Optional two-letter locale/country code, e.g. us, uk, in"
          },
          contentFilter: {
            type: "string",
            enum: ["off", "low", "medium", "high"],
            description: "Optional safety filter"
          },
          perPage: {
            type: "integer",
            description: "Optional search breadth (1-20) before choosing one GIF"
          }
        },
        required: ["query"]
      }
    });

    tools.push({
      name: "send_klipy_gif",
      description:
        "Search KLIPY GIF API by query and send one relevant GIF back to chat. Useful for reaction replies and forwarded GIF vibes.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Keyword phrase for GIF search, e.g. happy dance, angry reaction, facepalm"
          },
          targetChatJid: {
            type: "string",
            description: "Optional destination chat JID; defaults to current chat"
          },
          customerId: {
            type: "string",
            description:
              "Optional stable user id for personalization/analytics; defaults to current sender"
          },
          locale: {
            type: "string",
            description: "Optional two-letter locale/country code, e.g. us, uk, in"
          },
          contentFilter: {
            type: "string",
            enum: ["off", "low", "medium", "high"],
            description: "Optional safety filter"
          },
          perPage: {
            type: "integer",
            description: "Optional search breadth (1-20) before choosing one GIF"
          }
        },
        required: ["query"]
      }
    });
  }

  return tools;
}

export async function executeToolCall(
  call: GeminiToolCall,
  runtime: ToolRuntimeContext
): Promise<ToolExecutionResult> {
  if (!runtime.config.toolCallingEnabled) {
    return { ok: false, message: "tool calling disabled by config" };
  }

  const name = compactText(call.name);
  if (!name) return { ok: false, message: "tool call name missing" };

  try {
    switch (name) {
      case "list_available_tools":
        return executeListAvailableTools(runtime);
      case "list_local_files":
        return executeListLocalFiles(call.args, runtime.config, runtime.currentChatJid);
      case "read_local_file":
        return executeReadLocalFile(call.args, runtime.config, runtime.currentChatJid);
      case "share_local_file":
        return executeShareLocalFile(call.args, runtime);
      case "send_sticker":
        return executeSendSticker(call.args, runtime);
      case "end_voice_reply":
      case "send_voice_reply":
        return executeSendVoiceReply(call.args, runtime);
      case "send_image_reply":
        return executeSendImageReply(call.args, runtime);
      case "send_meme_reply":
        return executeSendMemeReply(call.args, runtime);
      case "send_styled_quote_card":
        return executeSendStyledQuoteCard(call.args, runtime);
      case "send_voice_plus_text":
        return executeSendVoicePlusText(call.args, runtime);
      case "send_reaction_combo":
        return executeSendReactionCombo(call.args, runtime);
      case "send_gif":
      case "send_klipy_gif":
        return executeSendKlipyGif(call.args, runtime);
      default:
        appendToolActionLog({
          tool: name,
          ok: false,
          chatJid: runtime.currentChatJid,
          message: "unknown tool name"
        });
        return { ok: false, message: `unknown tool: ${name}` };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendToolActionLog({
      tool: name,
      ok: false,
      chatJid: runtime.currentChatJid,
      message
    });
    return { ok: false, message };
  }
}

function executeListAvailableTools(runtime: ToolRuntimeContext): ToolExecutionResult {
  const toolNames = runtime.availableToolNames?.filter(Boolean) ?? [];
  const unique = Array.from(new Set(toolNames));
  const message =
    unique.length > 0
      ? `available tools: ${unique.join(", ")}`
      : "available tools could not be resolved";

  appendToolActionLog({
    tool: "list_available_tools",
    ok: unique.length > 0,
    chatJid: runtime.currentChatJid,
    message
  });

  return {
    ok: unique.length > 0,
    message,
    data: {
      tools: unique
    }
  };
}

function executeListLocalFiles(
  args: Record<string, unknown>,
  config: AppConfig,
  currentChatJid: string
): ToolExecutionResult {
  const requestPath = compactText(String(args.path ?? ""));
  if (!requestPath) {
    return { ok: false, message: "path is required" };
  }

  const result = listLocalFilesTool(
    {
      path: requestPath,
      recursive: Boolean(args.recursive),
      limit: asInt(args.limit),
      maxDepth: asInt(args.maxDepth)
    },
    config
  );

  if (!result.ok || !result.result) {
    appendToolActionLog({
      tool: "list_local_files",
      ok: false,
      chatJid: currentChatJid,
      path: requestPath,
      message: result.reason ?? "failed"
    });
    return { ok: false, message: result.reason ?? "list failed" };
  }

  appendToolActionLog({
    tool: "list_local_files",
    ok: true,
    chatJid: currentChatJid,
    path: result.result.path,
    message: `returned ${result.result.entries.length} entries`
  });
  return {
    ok: true,
    message: `listed ${result.result.entries.length} entries`,
    data: result.result
  };
}

function executeReadLocalFile(
  args: Record<string, unknown>,
  config: AppConfig,
  currentChatJid: string
): ToolExecutionResult {
  const requestPath = compactText(String(args.path ?? ""));
  if (!requestPath) {
    return { ok: false, message: "path is required" };
  }

  const result = readLocalFileTool(
    {
      path: requestPath,
      maxBytes: asInt(args.maxBytes)
    },
    config
  );

  if (!result.ok || !result.result) {
    appendToolActionLog({
      tool: "read_local_file",
      ok: false,
      chatJid: currentChatJid,
      path: requestPath,
      message: result.reason ?? "failed"
    });
    return { ok: false, message: result.reason ?? "read failed" };
  }

  appendToolActionLog({
    tool: "read_local_file",
    ok: true,
    chatJid: currentChatJid,
    path: result.result.path,
    message: `read ${result.result.sizeBytes} bytes (${result.result.encoding})`
  });

  return {
    ok: true,
    message: `read file (${result.result.encoding})`,
    data: result.result
  };
}

async function executeShareLocalFile(
  args: Record<string, unknown>,
  runtime: ToolRuntimeContext
): Promise<ToolExecutionResult> {
  const requestPath = compactText(String(args.path ?? ""));
  if (!requestPath) {
    return { ok: false, message: "path is required" };
  }

  const targetChatJid = compactText(String(args.targetChatJid ?? runtime.currentChatJid));
  const caption = compactText(String(args.caption ?? ""));
  const maxFiles = clampInt(asInt(args.maxFiles) ?? 4, 1, 12);
  if (!targetChatJid) {
    return { ok: false, message: "target chat id is required" };
  }

  const targetCheck = isShareTargetAllowed(targetChatJid, runtime.config);
  if (!targetCheck.allowed) {
    appendToolActionLog({
      tool: "share_local_file",
      ok: false,
      chatJid: runtime.currentChatJid,
      targetJid: targetChatJid,
      path: requestPath,
      message: targetCheck.reason
    });
    return { ok: false, message: targetCheck.reason };
  }

  const resolved = resolveAllowedPath(requestPath, runtime.config, {
    allowDirectory: true,
    allowMissing: false
  });
  if (!resolved.ok || !resolved.absolutePath) {
    appendToolActionLog({
      tool: "share_local_file",
      ok: false,
      chatJid: runtime.currentChatJid,
      targetJid: targetChatJid,
      path: requestPath,
      message: resolved.reason ?? "path rejected"
    });
    return { ok: false, message: resolved.reason ?? "path rejected" };
  }

  if (!existsSync(resolved.absolutePath)) {
    return { ok: false, message: `path not found: ${resolved.absolutePath}` };
  }

  if (lstatSync(resolved.absolutePath).isDirectory()) {
    const files = readdirSync(resolved.absolutePath)
      .map((name) => path.join(resolved.absolutePath as string, name))
      .filter((candidate) => existsSync(candidate) && lstatSync(candidate).isFile());

    const preferredMedia = files.filter((filePath) => isPreferredMediaFile(filePath));
    const pool = preferredMedia.length > 0 ? preferredMedia : files;
    const selected = pool.slice(0, maxFiles);

    if (selected.length === 0) {
      return { ok: false, message: `folder has no files to share: ${resolved.absolutePath}` };
    }

    let sent = 0;
    const sentFiles: string[] = [];
    for (const filePath of selected) {
      const fileStats = statSync(filePath);
      if (fileStats.size > runtime.config.maxShareFileBytes) {
        continue;
      }
      await runtime.sendFile({
        chatJid: targetChatJid,
        absolutePath: filePath,
        fileName: path.basename(filePath),
        caption: caption || undefined
      });
      sent += 1;
      sentFiles.push(filePath);
    }

    if (sent === 0) {
      return {
        ok: false,
        message: `no files sent (all over size limit or unavailable) from ${resolved.absolutePath}`
      };
    }

    appendToolActionLog({
      tool: "share_local_file",
      ok: true,
      chatJid: runtime.currentChatJid,
      targetJid: targetChatJid,
      path: resolved.absolutePath,
      message: `shared ${sent} file(s) from folder`
    });

    return {
      ok: true,
      message: `shared ${sent} file(s) to ${targetChatJid}`,
      sentMessage: true,
      data: {
        folderPath: resolved.absolutePath,
        targetChatJid,
        sentFiles
      }
    };
  }

  if (!lstatSync(resolved.absolutePath).isFile()) {
    return { ok: false, message: `not a file path: ${resolved.absolutePath}` };
  }

  const stats = statSync(resolved.absolutePath);
  if (stats.size > runtime.config.maxShareFileBytes) {
    return {
      ok: false,
      message: `file exceeds share limit (${runtime.config.maxShareFileBytes} bytes)`
    };
  }

  await runtime.sendFile({
    chatJid: targetChatJid,
    absolutePath: resolved.absolutePath,
    fileName: path.basename(resolved.absolutePath),
    caption: caption || undefined
  });

  appendToolActionLog({
    tool: "share_local_file",
    ok: true,
    chatJid: runtime.currentChatJid,
    targetJid: targetChatJid,
    path: resolved.absolutePath,
    message: `shared ${stats.size} bytes`
  });

  return {
    ok: true,
    message: `shared file to ${targetChatJid}`,
    sentMessage: true,
    data: {
      path: resolved.absolutePath,
      targetChatJid,
      sizeBytes: stats.size
    }
  };
}

async function executeSendSticker(
  args: Record<string, unknown>,
  runtime: ToolRuntimeContext
): Promise<ToolExecutionResult> {
  const targetChatJid = compactText(String(args.targetChatJid ?? runtime.currentChatJid));
  const query = compactText(String(args.query ?? ""));
  if (!targetChatJid) {
    return { ok: false, message: "target chat id is required" };
  }

  const targetCheck = isShareTargetAllowed(targetChatJid, runtime.config);
  if (!targetCheck.allowed) {
    appendToolActionLog({
      tool: "send_sticker",
      ok: false,
      chatJid: runtime.currentChatJid,
      targetJid: targetChatJid,
      message: targetCheck.reason
    });
    return { ok: false, message: targetCheck.reason };
  }

  const sent = await runtime.sendStickerByQuery({
    chatJid: targetChatJid,
    query: query || undefined
  });

  appendToolActionLog({
    tool: "send_sticker",
    ok: sent.ok,
    chatJid: runtime.currentChatJid,
    targetJid: targetChatJid,
    message: sent.message
  });

  return {
    ok: sent.ok,
    message: sent.message,
    sentMessage: sent.ok,
    data: sent.source ? { source: sent.source } : undefined
  };
}

async function executeSendKlipyGif(
  args: Record<string, unknown>,
  runtime: ToolRuntimeContext
): Promise<ToolExecutionResult> {
  const query = compactText(String(args.query ?? ""));
  if (!query) {
    return { ok: false, message: "query is required" };
  }

  const targetChatJid = compactText(String(args.targetChatJid ?? runtime.currentChatJid));
  if (!targetChatJid) {
    return { ok: false, message: "target chat id is required" };
  }

  const targetCheck = isShareTargetAllowed(targetChatJid, runtime.config);
  if (!targetCheck.allowed) {
    appendToolActionLog({
      tool: "send_klipy_gif",
      ok: false,
      chatJid: runtime.currentChatJid,
      targetJid: targetChatJid,
      message: targetCheck.reason
    });
    return { ok: false, message: targetCheck.reason };
  }

  const customerId = compactText(String(args.customerId ?? runtime.currentSenderJid));
  const locale = compactText(String(args.locale ?? ""));
  const perPage = clampInt(asInt(args.perPage) ?? 8, 1, 20);
  const rawContentFilter = compactText(String(args.contentFilter ?? "")).toLowerCase();
  const contentFilter =
    rawContentFilter === "off" ||
    rawContentFilter === "low" ||
    rawContentFilter === "medium" ||
    rawContentFilter === "high"
      ? rawContentFilter
      : undefined;

  const sent = await runtime.sendKlipyGifByQuery({
    chatJid: targetChatJid,
    query,
    customerId: customerId || undefined,
    locale: locale || undefined,
    contentFilter,
    perPage
  });

  appendToolActionLog({
    tool: "send_klipy_gif",
    ok: sent.ok,
    chatJid: runtime.currentChatJid,
    targetJid: targetChatJid,
    message: sent.message
  });

  return {
    ok: sent.ok,
    message: sent.message,
    sentMessage: sent.ok,
    data: sent.data
  };
}

async function executeSendVoiceReply(
  args: Record<string, unknown>,
  runtime: ToolRuntimeContext
): Promise<ToolExecutionResult> {
  const text = compactText(String(args.text ?? ""));
  if (!text) {
    return { ok: false, message: "text is required" };
  }

  const targetChatJid = compactText(String(args.targetChatJid ?? runtime.currentChatJid));
  if (!targetChatJid) {
    return { ok: false, message: "target chat id is required" };
  }

  const targetCheck = isShareTargetAllowed(targetChatJid, runtime.config);
  if (!targetCheck.allowed) {
    return { ok: false, message: targetCheck.reason };
  }

  const voice = compactText(String(args.voice ?? "")) || undefined;
  const language = compactText(String(args.language ?? "")) || undefined;
  const speed = clampNumber(asNumber(args.speed) ?? 1, 0.5, 1.6);
  const speaker1Name = compactText(String(args.speaker1Name ?? "")) || undefined;
  const speaker1Voice = compactText(String(args.speaker1Voice ?? "")) || undefined;
  const speaker2Name = compactText(String(args.speaker2Name ?? "")) || undefined;
  const speaker2Voice = compactText(String(args.speaker2Voice ?? "")) || undefined;

  const sent = await runtime.sendVoiceReply({
    chatJid: targetChatJid,
    text,
    voice,
    language,
    speed,
    speaker1Name,
    speaker1Voice,
    speaker2Name,
    speaker2Voice
  });

  appendToolActionLog({
    tool: "send_voice_reply",
    ok: sent.ok,
    chatJid: runtime.currentChatJid,
    targetJid: targetChatJid,
    message: sent.message
  });

  return {
    ok: sent.ok,
    message: sent.message,
    sentMessage: sent.ok,
    data: sent.data
  };
}

async function executeSendImageReply(
  args: Record<string, unknown>,
  runtime: ToolRuntimeContext
): Promise<ToolExecutionResult> {
  const prompt = compactText(String(args.prompt ?? ""));
  if (!prompt) {
    return { ok: false, message: "prompt is required" };
  }

  const targetChatJid = compactText(String(args.targetChatJid ?? runtime.currentChatJid));
  if (!targetChatJid) {
    return { ok: false, message: "target chat id is required" };
  }

  const targetCheck = isShareTargetAllowed(targetChatJid, runtime.config);
  if (!targetCheck.allowed) {
    return { ok: false, message: targetCheck.reason };
  }

  const caption = compactText(String(args.caption ?? ""));
  const width = clampInt(asInt(args.width) ?? 1024, 512, 1536);
  const height = clampInt(asInt(args.height) ?? 1024, 512, 1536);

  const sent = await runtime.sendImageReply({
    chatJid: targetChatJid,
    prompt,
    caption: caption || undefined,
    width,
    height,
    style: "image"
  });

  appendToolActionLog({
    tool: "send_image_reply",
    ok: sent.ok,
    chatJid: runtime.currentChatJid,
    targetJid: targetChatJid,
    message: sent.message
  });

  return {
    ok: sent.ok,
    message: sent.message,
    sentMessage: sent.ok,
    data: sent.data
  };
}

async function executeSendMemeReply(
  args: Record<string, unknown>,
  runtime: ToolRuntimeContext
): Promise<ToolExecutionResult> {
  const sourceText = compactText(String(args.sourceText ?? ""));
  if (!sourceText) {
    return { ok: false, message: "sourceText is required" };
  }

  const targetChatJid = compactText(String(args.targetChatJid ?? runtime.currentChatJid));
  if (!targetChatJid) {
    return { ok: false, message: "target chat id is required" };
  }

  const tone = compactText(String(args.tone ?? "")) || "funny";
  const prompt = [
    "Create a meme-style reaction image.",
    `Tone: ${tone}.`,
    `Context: ${sourceText}`,
    "High contrast, expressive, social-media meme aesthetic, readable composition."
  ].join(" ");

  const sent = await runtime.sendImageReply({
    chatJid: targetChatJid,
    prompt,
    caption: `meme (${tone})`,
    width: 1024,
    height: 1024,
    style: "meme"
  });

  appendToolActionLog({
    tool: "send_meme_reply",
    ok: sent.ok,
    chatJid: runtime.currentChatJid,
    targetJid: targetChatJid,
    message: sent.message
  });

  return {
    ok: sent.ok,
    message: sent.message,
    sentMessage: sent.ok,
    data: sent.data
  };
}

async function executeSendStyledQuoteCard(
  args: Record<string, unknown>,
  runtime: ToolRuntimeContext
): Promise<ToolExecutionResult> {
  const quote = compactText(String(args.quote ?? ""));
  if (!quote) {
    return { ok: false, message: "quote is required" };
  }

  const targetChatJid = compactText(String(args.targetChatJid ?? runtime.currentChatJid));
  if (!targetChatJid) {
    return { ok: false, message: "target chat id is required" };
  }

  const author = compactText(String(args.author ?? ""));
  const prompt = [
    "Design a premium social quote card.",
    `Quote: \"${quote}\".`,
    author ? `Author: ${author}.` : "",
    "Typography-focused, elegant gradient background, modern visual hierarchy, high readability."
  ]
    .filter(Boolean)
    .join(" ");

  const sent = await runtime.sendImageReply({
    chatJid: targetChatJid,
    prompt,
    caption: author ? `\"${quote}\" — ${author}` : `\"${quote}\"`,
    width: 1080,
    height: 1080,
    style: "quote_card"
  });

  appendToolActionLog({
    tool: "send_styled_quote_card",
    ok: sent.ok,
    chatJid: runtime.currentChatJid,
    targetJid: targetChatJid,
    message: sent.message
  });

  return {
    ok: sent.ok,
    message: sent.message,
    sentMessage: sent.ok,
    data: sent.data
  };
}

async function executeSendVoicePlusText(
  args: Record<string, unknown>,
  runtime: ToolRuntimeContext
): Promise<ToolExecutionResult> {
  const text = compactText(String(args.text ?? ""));
  if (!text) {
    return { ok: false, message: "text is required" };
  }

  const targetChatJid = compactText(String(args.targetChatJid ?? runtime.currentChatJid));
  if (!targetChatJid) {
    return { ok: false, message: "target chat id is required" };
  }

  const fallbackText = compactText(String(args.fallbackText ?? "")) || text;
  const voice = compactText(String(args.voice ?? "")) || undefined;
  const language = compactText(String(args.language ?? "")) || undefined;
  const speed = clampNumber(asNumber(args.speed) ?? 1, 0.5, 1.6);
  const speaker1Name = compactText(String(args.speaker1Name ?? "")) || undefined;
  const speaker1Voice = compactText(String(args.speaker1Voice ?? "")) || undefined;
  const speaker2Name = compactText(String(args.speaker2Name ?? "")) || undefined;
  const speaker2Voice = compactText(String(args.speaker2Voice ?? "")) || undefined;

  const voiceResult = await runtime.sendVoiceReply({
    chatJid: targetChatJid,
    text,
    voice,
    language,
    speed,
    speaker1Name,
    speaker1Voice,
    speaker2Name,
    speaker2Voice
  });

  await runtime.sendTextMessage({
    chatJid: targetChatJid,
    text: fallbackText
  });

  const ok = voiceResult.ok;
  const message = ok
    ? `voice + text sent (${voiceResult.message})`
    : `voice failed but text sent (${voiceResult.message})`;

  appendToolActionLog({
    tool: "send_voice_plus_text",
    ok,
    chatJid: runtime.currentChatJid,
    targetJid: targetChatJid,
    message
  });

  return {
    ok,
    message,
    sentMessage: true,
    data: voiceResult.data
  };
}

async function executeSendReactionCombo(
  args: Record<string, unknown>,
  runtime: ToolRuntimeContext
): Promise<ToolExecutionResult> {
  const sourceText = compactText(String(args.sourceText ?? ""));
  const tone = compactText(String(args.tone ?? ""));
  const preferredMode = compactText(String(args.preferredMode ?? "auto")).toLowerCase();
  const targetChatJid = compactText(String(args.targetChatJid ?? runtime.currentChatJid));

  if (!targetChatJid) {
    return { ok: false, message: "target chat id is required" };
  }

  const mode =
    preferredMode === "sticker" ||
    preferredMode === "gif" ||
    preferredMode === "voice"
      ? preferredMode
      : pickReactionMode(sourceText, tone);

  if (mode === "sticker") {
    const query = deriveReactionQuery(sourceText || tone);
    const sent = await runtime.sendStickerByQuery({ chatJid: targetChatJid, query });
    return {
      ok: sent.ok,
      message: `reaction_combo(sticker): ${sent.message}`,
      sentMessage: sent.ok,
      data: sent.source ? { source: sent.source, mode } : { mode }
    };
  }

  if (mode === "gif") {
    const query = deriveReactionQuery(sourceText || tone || "reaction");
    const sent = await runtime.sendKlipyGifByQuery({
      chatJid: targetChatJid,
      query,
      customerId: runtime.currentSenderJid
    });
    return {
      ok: sent.ok,
      message: `reaction_combo(gif): ${sent.message}`,
      sentMessage: sent.ok,
      data: sent.data ? { ...sent.data, mode } : { mode }
    };
  }

  const spoken = sourceText || tone || "Nice one";
  const voice = await runtime.sendVoiceReply({
    chatJid: targetChatJid,
    text: spoken,
    speed: 1
  });
  return {
    ok: voice.ok,
    message: `reaction_combo(voice): ${voice.message}`,
    sentMessage: voice.ok,
    data: voice.data ? { ...voice.data, mode: "voice" } : { mode: "voice" }
  };
}

function asInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function isPreferredMediaFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return [
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".gif",
    ".bmp",
    ".mp4",
    ".mov",
    ".mkv"
  ].includes(ext);
}

function deriveReactionQuery(source: string): string {
  const normalized = compactText(source).toLowerCase();
  if (!normalized) return "funny reaction";
  return normalized
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(" ");
}

function pickReactionMode(sourceText: string, tone: string): "sticker" | "gif" | "voice" {
  const text = `${sourceText} ${tone}`.toLowerCase();
  if (/(lol|haha|funny|meme|roast|savage|hype|party|dance|excited)/.test(text)) {
    return "gif";
  }
  if (/(explain|long|serious|sorry|calm|comfort|motivate|sad|emotional)/.test(text)) {
    return "voice";
  }
  return "sticker";
}
