#!/usr/bin/env bun
import path from "node:path";
import { startControlServer } from "./web/control-server";
import { Command } from "commander";
import {
  CONFIG_PATH,
  DATA_DIR,
  ensureRuntimeDirs,
  loadConfig,
  loadEnv,
  repairWhatsAppSessionState,
  resetWhatsAppAuth,
  saveConfig,
  WA_LOCK_PATH,
  writeDefaultConfig
} from "./config";
import { acquireProcessLock } from "./lock";
import {
  defaultPersonaDumpPath,
  dumpPersonaMarkdown,
  ensureContactProfile,
  ensurePersonaScaffold,
  personaPaths
} from "./persona";
import {
  clearMemoryLocal,
  exportMemoryLocalMarkdown,
  listKnownDirectChatJidsFromLocal,
  listMemoryLocal
} from "./storage";
import {
  listActiveGroups,
  listJoinedGroups,
  sendDirectProactiveMessage,
  WhatsAppAgent
} from "./whatsapp";

const program = new Command();
program.name("talky").description("Local WhatsApp AI agent (Bun + TypeScript)");
ensureRuntimeDirs();

program
  .command("start")
  .description("Start WhatsApp listener and auto-reply agent")
  .action(async () => {
    const release = acquireProcessLock(WA_LOCK_PATH);
    const config = loadConfig();
    const env = loadEnv();
    const agent = new WhatsAppAgent(config, env);
    await agent.start();
    startControlServer(agent);
    try {
      await new Promise(() => undefined);
    } finally {
      release();
    }
  });

program
  .command("relink")
  .description("Delete existing WhatsApp auth session and relink with fresh QR")
  .option("--start", "start bot immediately after resetting auth")
  .action(async (opts: { start?: boolean }) => {
    const release = acquireProcessLock(WA_LOCK_PATH);
    resetWhatsAppAuth();
    console.log("Cleared previous WhatsApp auth in wa_auth/");
    if (!opts.start) {
      console.log("Run `bun run start` to scan a fresh QR and relink.");
      release();
      return;
    }
    const config = loadConfig();
    const env = loadEnv();
    const agent = new WhatsAppAgent(config, env);
    await agent.start();
    try {
      await new Promise(() => undefined);
    } finally {
      release();
    }
  });

program
  .command("session:repair")
  .description("Purge stale Signal/session files in wa_auth and restart with existing creds")
  .action(() => {
    const release = acquireProcessLock(WA_LOCK_PATH);
    try {
      const result = repairWhatsAppSessionState();
      console.log(`Repaired WhatsApp session state. Removed ${result.deleted} files from wa_auth/.`);
      console.log("Next step: run `bun run start` and wait 30-60 seconds for sessions to rebuild.");
      console.log("If errors continue, run `bun run relink` for a full QR relink.");
    } finally {
      release();
    }
  });

program
  .command("config:init")
  .description("Create default config.yaml")
  .action(() => {
    const cfg = writeDefaultConfig();
    console.log(`Wrote ${CONFIG_PATH}`);
    console.log(JSON.stringify(cfg, null, 2));
  });

program
  .command("config:show")
  .description("Show effective config")
  .action(() => {
    const config = loadConfig();
    console.log(JSON.stringify(config, null, 2));
  });

program
  .command("persona:init")
  .description("Create persona scaffold files (soul/rules/recent memory/contacts/groups)")
  .action(() => {
    ensurePersonaScaffold();
    console.log(JSON.stringify(personaPaths(), null, 2));
  });

program
  .command("persona:paths")
  .description("Show persona file/folder paths")
  .action(() => {
    ensurePersonaScaffold();
    console.log(JSON.stringify(personaPaths(), null, 2));
  });

program
  .command("persona:dump")
  .description("Export all persona files into one markdown file")
  .argument("[out]", "output markdown path")
  .action((out?: string) => {
    ensurePersonaScaffold();
    const outputPath = out ?? defaultPersonaDumpPath();
    const written = dumpPersonaMarkdown(outputPath);
    console.log(`Exported persona to ${written}`);
  });

program
  .command("memory:list")
  .description("List local markdown memories, optionally by JID")
  .argument("[jid]", "specific WhatsApp JID")
  .action((jid?: string) => {
    const data = listMemoryLocal(jid);
    console.log(JSON.stringify(data, null, 2));
  });

program
  .command("memory:clear")
  .description("Clear local markdown memories, optionally by JID")
  .argument("[jid]", "specific WhatsApp JID")
  .action((jid?: string) => {
    clearMemoryLocal(jid);
    console.log(jid ? `Cleared memory for ${jid}` : "Cleared all local memory files");
  });

program
  .command("memory:export")
  .description("Export local markdown memories into one markdown file")
  .argument("[out]", "output markdown path")
  .action((out?: string) => {
    const outputPath =
      out ?? path.join(DATA_DIR, `memory-export-${new Date().toISOString().slice(0, 10)}.md`);
    const written = exportMemoryLocalMarkdown(outputPath);
    console.log(`Exported memory to ${written}`);
  });

program
  .command("groups:list")
  .description("List joined WhatsApp groups with JID and name")
  .action(async () => {
    const release = acquireProcessLock(WA_LOCK_PATH);
    try {
      await listJoinedGroups();
    } finally {
      release();
    }
  });

program
  .command("groups:active")
  .description("List groups currently active for auto-reply based on config.yaml")
  .action(async () => {
    const release = acquireProcessLock(WA_LOCK_PATH);
    try {
      const config = loadConfig();
      await listActiveGroups(config);
    } finally {
      release();
    }
  });

program
  .command("direct:active")
  .description("Show current 1:1 direct-message auto-reply policy and allowed JIDs")
  .action(() => {
    const config = loadConfig();
    console.log(
      JSON.stringify(
        {
          runtimeLogMode: config.runtimeLogMode,
          directChatMode: config.directChatMode,
          allowedDirectJids: config.allowedDirectJids,
          selfSenderJids: config.selfSenderJids,
          selfHistoryWindow: config.selfHistoryWindow,
          proactiveOnStartupEnabled: config.proactiveOnStartupEnabled,
          proactiveOnStartupDirectJids: config.proactiveOnStartupDirectJids
        },
        null,
        2
      )
    );
  });

program
  .command("logs:mode")
  .description("Set runtime log mode (minimal or verbose)")
  .argument("<mode>", "minimal | verbose")
  .action((mode: string) => {
    const normalized = mode.trim().toLowerCase();
    if (normalized !== "minimal" && normalized !== "verbose") {
      console.error("Invalid mode. Use: minimal or verbose");
      process.exit(1);
    }
    const config = loadConfig();
    config.runtimeLogMode = normalized;
    saveConfig(config);
    console.log(`runtimeLogMode set to ${normalized}`);
  });

program
  .command("logs:toggle")
  .description("Toggle runtime log mode between minimal and verbose")
  .action(() => {
    const config = loadConfig();
    config.runtimeLogMode = config.runtimeLogMode === "verbose" ? "minimal" : "verbose";
    saveConfig(config);
    console.log(`runtimeLogMode toggled to ${config.runtimeLogMode}`);
  });

program
  .command("direct:list")
  .description("List known 1:1 direct JIDs from local chat history files")
  .action(() => {
    const jids = listKnownDirectChatJidsFromLocal();
    console.log(JSON.stringify(jids, null, 2));
  });

program
  .command("direct:allow")
  .description("Allow auto-reply to a 1:1 contact (JID or numeric id)")
  .argument("<jidOrId>", "e.g. 91987xxxxxxx@s.whatsapp.net or 91987xxxxxxx or <lid>@lid")
  .argument("[name]", "optional display name for this contact profile")
  .action((jidOrId: string, name?: string) => {
    const config = loadConfig();
    if (!config.allowedDirectJids.includes(jidOrId)) {
      config.allowedDirectJids.push(jidOrId);
      config.allowedDirectJids.sort();
    }
    config.directChatMode = "allowlist";
    saveConfig(config);
    const profilePath = ensureContactProfile(jidOrId, name);
    console.log(`Allowed direct chat id: ${jidOrId}`);
    if (name) {
      console.log(`Saved contact name: ${name}`);
    }
    console.log(`Contact profile: ${profilePath}`);
  });

program
  .command("direct:disallow")
  .description("Remove a 1:1 contact JID from allowlist")
  .argument("<jid>", "WhatsApp user JID like 91987xxxxxxx@s.whatsapp.net")
  .action((jid: string) => {
    const config = loadConfig();
    config.allowedDirectJids = config.allowedDirectJids.filter((x) => x !== jid);
    saveConfig(config);
    console.log(`Removed direct JID from allowlist: ${jid}`);
  });

program
  .command("self:add")
  .description("Mark a sender JID/id as me (skip replying when this sender appears in groups)")
  .argument("<jidOrId>", "e.g. 34312661561356@lid or 91973xxxxxxx@s.whatsapp.net")
  .action((jidOrId: string) => {
    const config = loadConfig();
    if (!config.selfSenderJids.includes(jidOrId)) {
      config.selfSenderJids.push(jidOrId);
      config.selfSenderJids.sort();
      saveConfig(config);
    }
    console.log(`Added self sender id: ${jidOrId}`);
  });

program
  .command("self:remove")
  .description("Remove a self sender JID/id")
  .argument("<jidOrId>", "jid/id to remove")
  .action((jidOrId: string) => {
    const config = loadConfig();
    config.selfSenderJids = config.selfSenderJids.filter((value) => value !== jidOrId);
    saveConfig(config);
    console.log(`Removed self sender id: ${jidOrId}`);
  });

program
  .command("direct:poke")
  .description("Send a proactive funny Banglish/Benglish message without waiting for inbound")
  .argument("<jidOrId>", "direct target JID or numeric id")
  .action(async (jidOrId: string) => {
    const release = acquireProcessLock(WA_LOCK_PATH);
    try {
      const config = loadConfig();
      const env = loadEnv();
      await sendDirectProactiveMessage({ target: jidOrId, config, env });
    } finally {
      release();
    }
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
