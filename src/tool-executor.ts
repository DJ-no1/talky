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
};

export function buildToolDeclarations(config: AppConfig): GeminiToolDeclaration[] {
  if (!config.toolCallingEnabled) return [];

  return [
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
    }
  ];
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
      case "list_local_files":
        return executeListLocalFiles(call.args, runtime.config, runtime.currentChatJid);
      case "read_local_file":
        return executeReadLocalFile(call.args, runtime.config, runtime.currentChatJid);
      case "share_local_file":
        return executeShareLocalFile(call.args, runtime);
      case "send_sticker":
        return executeSendSticker(call.args, runtime);
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

function asInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
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
