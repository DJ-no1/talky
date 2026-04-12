import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  PERSONA_CONTACTS_DIR,
  PERSONA_DIR,
  PERSONA_GROUPS_DIR,
  ROOT_DIR
} from "./config";
import type { PersonaContext } from "./types";
import { sanitizeJid } from "./utils";

const SOUL_PATH = path.join(PERSONA_DIR, "soul.md");
const COMM_RULES_PATH = path.join(PERSONA_DIR, "communication_rules.md");
const RECENT_MEMORY_PATH = path.join(PERSONA_DIR, "recent_memory.md");

export function ensurePersonaScaffold(): void {
  for (const folder of [PERSONA_DIR, PERSONA_CONTACTS_DIR, PERSONA_GROUPS_DIR]) {
    if (!existsSync(folder)) {
      mkdirSync(folder, { recursive: true });
    }
  }
  ensureFile(
    SOUL_PATH,
    [
      "# Soul (Who I Am)",
      "",
      "Name:",
      "Background:",
      "Values:",
      "What I care about:",
      "Boundaries:",
      "",
      "Add real details so the bot sounds like me."
    ].join("\n")
  );
  ensureFile(
    COMM_RULES_PATH,
    [
      "# Communication Rules",
      "",
      "Default tone:",
      "How I greet people:",
      "How direct/funny I am:",
      "Words/phrases I use often:",
      "Words to avoid:",
      "How I handle conflict:",
      "How I close chats:"
    ].join("\n")
  );
  ensureFile(
    RECENT_MEMORY_PATH,
    [
      "# Recent Memory",
      "",
      "- Current priorities:",
      "- Stress points:",
      "- Ongoing commitments:",
      "- Important dates:",
      "- Anything the bot should remember this week:"
    ].join("\n")
  );
}

export function ensureContactProfile(contactJidOrId: string): string {
  ensurePersonaScaffold();
  const filePath = contactProfilePath(contactJidOrId);
  ensureFile(
    filePath,
    [
      `# Contact Profile: ${contactJidOrId}`,
      "",
      "Relationship:",
      "How close we are:",
      "How I usually talk with this person:",
      "What this person cares about:",
      "Sensitive topics to avoid:",
      "Current ongoing topics/tasks:",
      "Good reply style examples:",
      "-",
      "-"
    ].join("\n")
  );
  return filePath;
}

export function ensureGroupProfile(groupJid: string): string {
  ensurePersonaScaffold();
  const filePath = groupProfilePath(groupJid);
  ensureFile(
    filePath,
    [
      `# Group Profile: ${groupJid}`,
      "",
      "Group purpose:",
      "My position/role in this group:",
      "How frequently I should talk here:",
      "My tone in this group:",
      "Topics where I should definitely respond:",
      "Topics where I should stay silent:",
      "People to be extra respectful with:",
      "Recent group context:"
    ].join("\n")
  );
  return filePath;
}

export function loadPersonaContext(args: {
  chatJid: string;
  senderJid: string;
  isGroup: boolean;
}): PersonaContext {
  ensurePersonaScaffold();
  const soul = readOrEmpty(SOUL_PATH);
  const communicationRules = readOrEmpty(COMM_RULES_PATH);
  const recentMemory = readOrEmpty(RECENT_MEMORY_PATH);

  const contactKey = args.isGroup ? args.senderJid : args.chatJid;
  const contactPath = contactProfilePath(contactKey);
  const contactProfile = existsSync(contactPath) ? readOrEmpty(contactPath) : "";

  const groupPath = groupProfilePath(args.chatJid);
  const groupProfile = args.isGroup && existsSync(groupPath) ? readOrEmpty(groupPath) : "";

  return {
    soul,
    communicationRules,
    recentMemory,
    contactProfile,
    groupProfile
  };
}

export function dumpPersonaMarkdown(targetPath: string): string {
  ensurePersonaScaffold();
  const blocks: string[] = [
    "# Persona Dump",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## soul.md",
    readOrEmpty(SOUL_PATH),
    "",
    "## communication_rules.md",
    readOrEmpty(COMM_RULES_PATH),
    "",
    "## recent_memory.md",
    readOrEmpty(RECENT_MEMORY_PATH),
    "",
    "## contacts/"
  ];

  for (const file of readdirSync(PERSONA_CONTACTS_DIR)) {
    if (!file.endsWith(".md")) continue;
    blocks.push(`### ${file}`);
    blocks.push(readOrEmpty(path.join(PERSONA_CONTACTS_DIR, file)));
    blocks.push("");
  }

  blocks.push("## groups/");
  for (const file of readdirSync(PERSONA_GROUPS_DIR)) {
    if (!file.endsWith(".md")) continue;
    blocks.push(`### ${file}`);
    blocks.push(readOrEmpty(path.join(PERSONA_GROUPS_DIR, file)));
    blocks.push("");
  }

  writeFileSync(targetPath, blocks.join("\n"), "utf-8");
  return targetPath;
}

export function personaPaths(): {
  root: string;
  soul: string;
  communicationRules: string;
  recentMemory: string;
  contacts: string;
  groups: string;
} {
  return {
    root: PERSONA_DIR,
    soul: SOUL_PATH,
    communicationRules: COMM_RULES_PATH,
    recentMemory: RECENT_MEMORY_PATH,
    contacts: PERSONA_CONTACTS_DIR,
    groups: PERSONA_GROUPS_DIR
  };
}

function contactProfilePath(contactJidOrId: string): string {
  return path.join(PERSONA_CONTACTS_DIR, `${sanitizeJid(contactJidOrId)}.md`);
}

function groupProfilePath(groupJid: string): string {
  return path.join(PERSONA_GROUPS_DIR, `${sanitizeJid(groupJid)}.md`);
}

function ensureFile(filePath: string, content: string): void {
  if (!existsSync(filePath)) {
    writeFileSync(filePath, `${content}\n`, "utf-8");
  }
}

function readOrEmpty(filePath: string): string {
  if (!existsSync(filePath)) return "";
  return readFileSync(filePath, "utf-8").trim();
}

export function defaultPersonaDumpPath(): string {
  return path.join(ROOT_DIR, "data", `persona-dump-${new Date().toISOString().slice(0, 10)}.md`);
}
