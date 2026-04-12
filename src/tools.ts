import {
  appendFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { ROOT_DIR, TOOL_ACTION_LOG_PATH } from "./config";
import type { AppConfig } from "./types";
import { compactText } from "./utils";

export type SafePathResult = {
  ok: boolean;
  absolutePath?: string;
  reason?: string;
};

export type LocalListResult = {
  path: string;
  entries: string[];
  truncated: boolean;
};

export type LocalReadResult = {
  path: string;
  sizeBytes: number;
  encoding: "utf8" | "base64";
  content: string;
  truncated: boolean;
};

export function resolveAllowedPath(
  requestedPath: string,
  config: AppConfig,
  options?: {
    allowDirectory?: boolean;
    allowMissing?: boolean;
  }
): SafePathResult {
  const requested = compactText(requestedPath || "");
  if (!requested) {
    return { ok: false, reason: "path is required" };
  }

  const absolutePath = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(ROOT_DIR, requested);

  const allowedRoots =
    config.localFileAllowedRoots.length > 0 ? config.localFileAllowedRoots : [ROOT_DIR];
  const insideAllowedRoot = allowedRoots.some((root) => isPathInside(absolutePath, path.resolve(root)));
  if (!insideAllowedRoot) {
    return { ok: false, reason: `path is outside allowed roots: ${absolutePath}` };
  }

  const normalized = normalizePathForCompare(absolutePath);
  for (const fragment of config.localFileBlockedPathFragments) {
    const needle = normalizePathForCompare(fragment);
    if (!needle) continue;
    if (normalized.includes(needle)) {
      return { ok: false, reason: `path is blocked by policy: ${absolutePath}` };
    }
  }

  const extension = normalizeExtension(path.extname(absolutePath));
  if (
    extension &&
    config.localFileBlockedExtensions.map((item) => normalizeExtension(item)).includes(extension)
  ) {
    return { ok: false, reason: `file extension is blocked by policy: ${extension}` };
  }

  if (!options?.allowMissing && !existsSync(absolutePath)) {
    return { ok: false, reason: `path not found: ${absolutePath}` };
  }

  if (existsSync(absolutePath) && !options?.allowDirectory && lstatSync(absolutePath).isDirectory()) {
    return { ok: false, reason: `path is a directory: ${absolutePath}` };
  }

  return { ok: true, absolutePath };
}

export function listLocalFilesTool(args: {
  path: string;
  recursive?: boolean;
  limit?: number;
  maxDepth?: number;
}, config: AppConfig): SafePathResult & { result?: LocalListResult } {
  const resolved = resolveAllowedPath(args.path, config, { allowDirectory: true });
  if (!resolved.ok) return resolved;

  const rootPath = resolved.absolutePath as string;
  if (!existsSync(rootPath) || !lstatSync(rootPath).isDirectory()) {
    return { ok: false, reason: `directory not found: ${rootPath}` };
  }

  const recursive = Boolean(args.recursive);
  const limit = clampInt(args.limit ?? 60, 1, 300);
  const maxDepth = clampInt(args.maxDepth ?? 3, 0, 8);

  const entries: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootPath, depth: 0 }];

  while (queue.length > 0 && entries.length < limit) {
    const current = queue.shift();
    if (!current) break;

    for (const name of readdirSync(current.dir)) {
      const absolute = path.join(current.dir, name);
      const safe = resolveAllowedPath(absolute, config, { allowDirectory: true, allowMissing: false });
      if (!safe.ok) continue;

      entries.push(absolute);
      if (entries.length >= limit) break;

      if (!recursive) continue;
      if (current.depth >= maxDepth) continue;
      if (lstatSync(absolute).isDirectory()) {
        queue.push({ dir: absolute, depth: current.depth + 1 });
      }
    }
  }

  return {
    ok: true,
    absolutePath: rootPath,
    result: {
      path: rootPath,
      entries,
      truncated: entries.length >= limit
    }
  };
}

export function readLocalFileTool(args: {
  path: string;
  maxBytes?: number;
}, config: AppConfig): SafePathResult & { result?: LocalReadResult } {
  const resolved = resolveAllowedPath(args.path, config, { allowDirectory: false });
  if (!resolved.ok) return resolved;

  const absolutePath = resolved.absolutePath as string;
  if (!existsSync(absolutePath) || !lstatSync(absolutePath).isFile()) {
    return { ok: false, reason: `file not found: ${absolutePath}` };
  }

  const fileStat = statSync(absolutePath);
  const maxBytes = clampInt(args.maxBytes ?? config.maxToolReadFileBytes, 8_192, config.maxToolReadFileBytes);
  if (fileStat.size > config.maxToolReadFileBytes) {
    return {
      ok: false,
      reason: `file exceeds tool read limit (${config.maxToolReadFileBytes} bytes): ${absolutePath}`
    };
  }

  const raw = readFileSync(absolutePath);
  const slice = raw.subarray(0, maxBytes);
  const hasNullByte = slice.includes(0);

  if (hasNullByte) {
    return {
      ok: true,
      absolutePath,
      result: {
        path: absolutePath,
        sizeBytes: fileStat.size,
        encoding: "base64",
        content: slice.toString("base64"),
        truncated: raw.length > slice.length
      }
    };
  }

  const text = slice.toString("utf-8");
  return {
    ok: true,
    absolutePath,
    result: {
      path: absolutePath,
      sizeBytes: fileStat.size,
      encoding: "utf8",
      content: text,
      truncated: raw.length > slice.length
    }
  };
}

export function isShareTargetAllowed(targetJid: string, config: AppConfig): {
  allowed: boolean;
  reason: string;
} {
  if (!targetJid.trim()) {
    return { allowed: false, reason: "target chat id is required" };
  }

  const normalizedTarget = targetJid.trim().toLowerCase();
  const isGroup = normalizedTarget.endsWith("@g.us");

  if (isGroup) {
    if (!config.allowShareToAllowedGroups) {
      return { allowed: false, reason: "group file share is disabled in config" };
    }
    if (config.allowedGroupJids.length === 0) {
      return { allowed: true, reason: "group allowed (no allowlist configured)" };
    }
    if (!config.allowedGroupJids.includes(targetJid)) {
      return { allowed: false, reason: "group is not in allowedGroupJids" };
    }
    return { allowed: true, reason: "group allowed" };
  }

  if (config.directChatMode === "none") {
    return { allowed: false, reason: "directChatMode=none" };
  }
  if (config.directChatMode === "all") {
    return { allowed: true, reason: "directChatMode=all" };
  }

  const allowed = config.allowedDirectJids.some((jid) => directIdentifierMatch(jid, targetJid));
  if (!allowed) {
    return { allowed: false, reason: "direct target not in allowedDirectJids" };
  }
  return { allowed: true, reason: "direct target allowed" };
}

export function appendToolActionLog(args: {
  tool: string;
  ok: boolean;
  message: string;
  chatJid?: string;
  targetJid?: string;
  path?: string;
}): void {
  if (!existsSync(TOOL_ACTION_LOG_PATH)) {
    writeFileSync(TOOL_ACTION_LOG_PATH, "# Tool Action Log\n\n", "utf-8");
  }

  const row = [
    new Date().toISOString(),
    `tool=${args.tool}`,
    `ok=${args.ok}`,
    args.chatJid ? `chat=${args.chatJid}` : "",
    args.targetJid ? `target=${args.targetJid}` : "",
    args.path ? `path=${args.path}` : "",
    `message=${args.message}`
  ]
    .filter(Boolean)
    .join(" | ");

  appendFileSync(TOOL_ACTION_LOG_PATH, `- ${row}\n`, "utf-8");
}

function directIdentifierMatch(left: string, right: string): boolean {
  const a = buildDirectIdentifiers(left);
  const b = buildDirectIdentifiers(right);
  for (const value of a) {
    if (b.has(value)) return true;
  }
  return false;
}

function buildDirectIdentifiers(input: string): Set<string> {
  const set = new Set<string>();
  const raw = input.trim().toLowerCase();
  if (!raw) return set;

  set.add(raw);
  const userPart = raw.split("@")[0]?.split(":")[0] ?? "";
  if (userPart) {
    set.add(userPart);
    set.add(`${userPart}@s.whatsapp.net`);
    set.add(`${userPart}@lid`);
  }

  return set;
}

function isPathInside(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel.length === 0 || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function normalizeExtension(value: string): string {
  const ext = value.trim().toLowerCase();
  if (!ext) return "";
  return ext.startsWith(".") ? ext : `.${ext}`;
}

function normalizePathForCompare(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
