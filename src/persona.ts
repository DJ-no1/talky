import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import {
  PERSONA_CONTACTS_DIR,
  PERSONA_DIR,
  PERSONA_GROUPS_DIR,
  ROOT_DIR
} from "./config";
import type { PersonaContext } from "./types";
import { compactText, sanitizeJid } from "./utils";

const SOUL_PATH = path.join(PERSONA_DIR, "soul.md");
const COMM_RULES_PATH = path.join(PERSONA_DIR, "communication_rules.md");
const RECENT_MEMORY_PATH = path.join(PERSONA_DIR, "recent_memory.md");

const FACTS_SECTION = "## Facts learned from chats";

function buildPersonaSetupHints(soul: string, communicationRules: string): string[] {
  const warnings: string[] = [];
  const soulT = soul.trim();
  const commT = communicationRules.trim();
  if (soulT.length < 60 || /add real details so the bot sounds like me/i.test(soulT)) {
    warnings.push(
      "persona/soul.md still looks like the scaffold — add your real name, background, and boundaries."
    );
  }
  if (commT.length < 80 || /\bwords\/phrases i use often:\s*$/im.test(commT)) {
    warnings.push(
      "persona/communication_rules.md is sparse — describe tone, greetings, phrases you use, and closings."
    );
  }
  return warnings;
}

export function appendExtractedFactToContactProfile(contactJid: string, fact: string): void {
  const line = compactText(fact);
  if (!line) return;
  ensurePersonaScaffold();
  const filePath = ensureContactProfile(contactJid);
  let raw = readFileSync(filePath, "utf-8");
  const stamp = new Date().toISOString().slice(0, 10);
  const bullet = `- ${stamp} (extracted memory) ${line}`;
  if (!raw.includes(FACTS_SECTION)) {
    raw = `${raw.trimEnd()}\n\n${FACTS_SECTION}\n${bullet}\n`;
  } else {
    raw = `${raw.trimEnd()}\n${bullet}\n`;
  }
  writeFileSync(filePath, raw, "utf-8");
}

export async function runPersonaWizard(): Promise<void> {
  ensurePersonaScaffold();
  const rl = createInterface({ input, output });
  console.log("");
  console.log("Talky persona wizard — seeds persona/soul.md and persona/communication_rules.md.");
  console.log("(Leave optional answers blank.)\n");
  try {
    const name = compactText(await rl.question("Name / how intro should feel? "));
    const background = compactText(await rl.question("One line about you (work, city, vibe)? "));
    const values = compactText(await rl.question("What do you optimize for in chats (honesty, warmth, brevity)? "));
    const tone = compactText(await rl.question("Default tone in chats (casual Banglish, formal, chaotic)? "));
    const phrases = compactText(await rl.question("Phrases you actually say (comma-separated)? "));

    const soulBlocks = [
      "# Soul (Who I Am)",
      "",
      name ? `Name / alias: ${name}` : "Name:",
      "",
      background ? `Background: ${background}` : "Background:",
      "",
      values ? `Values: ${values}` : "Values:",
      "",
      "Boundaries: (optional — things the bot should refuse or soften)"
    ];

    const commBlocks = [
      "# Communication Rules",
      "",
      tone ? `Default tone: ${tone}` : "Default tone:",
      "",
      "How I greet people:",
      "",
      phrases ? `Words/phrases I use often: ${phrases}` : "Words/phrases I use often:",
      "",
      "Words to avoid:",
      "",
      "How I handle conflict:",
      "",
      "How I close chats:"
    ];

    writeFileSync(SOUL_PATH, `${soulBlocks.join("\n")}\n`, "utf-8");
    writeFileSync(COMM_RULES_PATH, `${commBlocks.join("\n")}\n`, "utf-8");
    console.log(`\nUpdated:\n  ${SOUL_PATH}\n  ${COMM_RULES_PATH}\n`);
  } finally {
    await rl.close();
  }
}

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

export function ensureContactProfile(contactJidOrId: string, displayName?: string): string {
  ensurePersonaScaffold();
  const filePath = contactProfilePath(contactJidOrId);
  const normalizedName = normalizeDisplayName(displayName, contactJidOrId);
  ensureFile(
    filePath,
    buildContactProfileTemplate(contactJidOrId, normalizedName)
  );
  syncContactProfileMetadata(filePath, contactJidOrId, normalizedName);
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

  const personaSetupHints = buildPersonaSetupHints(soul, communicationRules);

  return {
    soul,
    communicationRules,
    recentMemory,
    contactProfile,
    groupProfile,
    ...(personaSetupHints.length ? { personaSetupHints } : {})
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

function buildContactProfileTemplate(contactJidOrId: string, displayName: string): string {
  return [
    `# Contact Profile: ${contactJidOrId}`,
    "",
    displayName ? `Name: ${displayName}` : "Name:",
    `JID: ${contactJidOrId}`,
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
  ].join("\n");
}

function syncContactProfileMetadata(
  filePath: string,
  contactJidOrId: string,
  displayName: string
): void {
  if (!existsSync(filePath)) return;

  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  let changed = false;

  const titleIndex = lines.findIndex((line) => line.startsWith("# Contact Profile:"));
  let insertAt = titleIndex >= 0 ? titleIndex + 1 : 0;
  if (lines[insertAt] === "") {
    insertAt += 1;
  }

  let nameIndex = lines.findIndex((line) => line.startsWith("Name:"));
  if (nameIndex === -1) {
    lines.splice(insertAt, 0, displayName ? `Name: ${displayName}` : "Name:");
    nameIndex = insertAt;
    changed = true;
  } else {
    const currentName = lines[nameIndex].slice("Name:".length).trim();
    if (displayName && (!currentName || currentName === contactJidOrId)) {
      lines[nameIndex] = `Name: ${displayName}`;
      changed = true;
    }
  }

  let jidIndex = lines.findIndex((line) => line.startsWith("JID:"));
  if (jidIndex === -1) {
    const insertJidAt = Math.min(nameIndex + 1, lines.length);
    lines.splice(insertJidAt, 0, `JID: ${contactJidOrId}`);
    jidIndex = insertJidAt;
    changed = true;
  } else {
    const currentJid = lines[jidIndex].slice("JID:".length).trim();
    if (!currentJid) {
      lines[jidIndex] = `JID: ${contactJidOrId}`;
      changed = true;
    }
  }

  if (jidIndex >= 0 && lines[jidIndex + 1] !== "") {
    lines.splice(jidIndex + 1, 0, "");
    changed = true;
  }

  if (!changed) return;

  writeFileSync(filePath, `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`, "utf-8");
}

function normalizeDisplayName(displayName: string | undefined, contactJidOrId: string): string {
  const normalized = compactText(displayName ?? "");
  if (!normalized) return "";
  const lowered = normalized.toLowerCase();
  if (lowered === "unknown" || lowered === "null" || lowered === "undefined") return "";
  if (normalized === contactJidOrId) return "";
  return normalized;
}
