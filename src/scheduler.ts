import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config";
import type { AppConfig } from "./types";
import {
  listPendingDue,
  markReminderNotified,
  pruneOldReminders,
  type Reminder
} from "./reminders";
import { Summarizer, formatDigestReply } from "./summarizer";
import type { MemoryService } from "./memory";
import { rebuildFromMarkdown } from "./memory-db";
import type { EmbeddingProvider } from "./embeddings";

export type SchedulerTelemetryPath = string;

export type SchedulerCallbacks = {
  sendDirectMessage: (jid: string, text: string) => Promise<void>;
  resolveGroupLabel: (jid: string) => string;
};

export type SchedulerDeps = {
  config: () => AppConfig;
  ownerJid: () => string;
  summarizer: Summarizer;
  memory: MemoryService;
  embeddings?: EmbeddingProvider;
  callbacks: SchedulerCallbacks;
  logger?: { info: (msg: unknown, label?: string) => void; warn: (msg: unknown, label?: string) => void };
};

const STATE_PATH = path.join(DATA_DIR, "scheduler-state.json");

type SchedulerState = {
  lastDigestISO?: string;
  lastConsolidateISO?: string;
  version: 1;
};

const DIGEST_TICK_MS = 5 * 60 * 1000;
const CONSOLIDATE_TICK_MS = 60 * 60 * 1000;
const DIGEST_WINDOW_HOURS = 24;

export class Scheduler {
  private reminderTimer: ReturnType<typeof setInterval> | null = null;
  private digestTimer: ReturnType<typeof setInterval> | null = null;
  private consolidateTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly deps: SchedulerDeps) {}

  start(): void {
    if (this.stopped) return;
    if (this.reminderTimer || this.digestTimer || this.consolidateTimer) return;

    const reminderPollSeconds = Math.max(
      10,
      Math.min(600, this.deps.config().selfChatReminderPollSeconds ?? 30)
    );

    this.reminderTimer = setInterval(() => {
      void this.tickReminders().catch((error) => this.logWarn(error, "scheduler.reminders"));
    }, reminderPollSeconds * 1000);

    this.digestTimer = setInterval(() => {
      void this.tickDigest().catch((error) => this.logWarn(error, "scheduler.digest"));
    }, DIGEST_TICK_MS);

    this.consolidateTimer = setInterval(() => {
      void this.tickConsolidate().catch((error) =>
        this.logWarn(error, "scheduler.consolidate")
      );
    }, CONSOLIDATE_TICK_MS);

    setTimeout(() => {
      void this.tickReminders().catch((error) => this.logWarn(error, "scheduler.reminders.init"));
    }, 5_000);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of [this.reminderTimer, this.digestTimer, this.consolidateTimer]) {
      if (timer) clearInterval(timer);
    }
    this.reminderTimer = null;
    this.digestTimer = null;
    this.consolidateTimer = null;
  }

  private async tickReminders(): Promise<void> {
    const config = this.deps.config();
    if (!config.selfChatEnabled) return;
    const owner = this.deps.ownerJid();
    if (!owner) return;

    const due = listPendingDue();
    if (due.length === 0) return;

    for (const reminder of due) {
      const targetJid = reminder.targetJid || reminder.ownerJid || owner;
      const message = formatReminderDelivery(reminder);
      try {
        await this.deps.callbacks.sendDirectMessage(targetJid, message);
        markReminderNotified(reminder.id);
        this.logInfo(
          { reminderId: reminder.id, targetJid, dueAtISO: reminder.dueAtISO },
          "reminder delivered"
        );
      } catch (error) {
        this.logWarn({ err: stringifyError(error), reminderId: reminder.id }, "reminder delivery failed");
      }
    }

    pruneOldReminders(30);
  }

  private async tickDigest(): Promise<void> {
    const config = this.deps.config();
    if (!config.selfChatEnabled) return;
    if (config.selfChatDigestEnabled === false) return;
    const owner = this.deps.ownerJid();
    if (!owner) return;

    const state = loadState();
    const now = new Date();
    const digestHour = clampHour(config.selfChatDigestHour ?? 9);
    if (!shouldSendDigest(state, now, digestHour)) return;

    const entries = await this.deps.summarizer.buildDigest(
      { hours: DIGEST_WINDOW_HOURS, model: config.model },
      this.deps.callbacks.resolveGroupLabel
    );
    const body = formatDigestReply(entries, DIGEST_WINDOW_HOURS);

    try {
      await this.deps.callbacks.sendDirectMessage(owner, `Daily digest\n\n${body}`);
      state.lastDigestISO = now.toISOString();
      saveState(state);
      this.logInfo({ entries: entries.length }, "daily digest sent");
    } catch (error) {
      this.logWarn({ err: stringifyError(error) }, "daily digest failed");
    }
  }

  private async tickConsolidate(): Promise<void> {
    const state = loadState();
    const now = new Date();
    const last = state.lastConsolidateISO ? Date.parse(state.lastConsolidateISO) : 0;
    const hours = Math.max(1, Math.min(168, this.deps.config().memoryConsolidationHours ?? 6));
    if (Number.isFinite(last) && now.getTime() - last < hours * 60 * 60 * 1000) return;

    const embedFn = this.deps.embeddings?.enabled
      ? (text: string) => this.deps.embeddings!.embed(text)
      : undefined;

    try {
      const stats = await rebuildFromMarkdown(embedFn);
      state.lastConsolidateISO = now.toISOString();
      saveState(state);
      this.logInfo(stats, "memory consolidation complete");
    } catch (error) {
      this.logWarn({ err: stringifyError(error) }, "memory consolidation failed");
    }
  }

  private logInfo(payload: unknown, label: string): void {
    if (this.deps.logger) this.deps.logger.info(payload, label);
  }

  private logWarn(payload: unknown, label: string): void {
    if (this.deps.logger) this.deps.logger.warn(payload, label);
  }
}

function shouldSendDigest(state: SchedulerState, now: Date, digestHour: number): boolean {
  if (now.getHours() !== digestHour) return false;
  const lastISO = state.lastDigestISO;
  if (!lastISO) return true;
  const last = new Date(lastISO);
  if (!Number.isFinite(last.getTime())) return true;
  return (
    last.getFullYear() !== now.getFullYear() ||
    last.getMonth() !== now.getMonth() ||
    last.getDate() !== now.getDate()
  );
}

function clampHour(value: number): number {
  if (!Number.isFinite(value)) return 9;
  return Math.min(23, Math.max(0, Math.floor(value)));
}

function formatReminderDelivery(reminder: Reminder): string {
  const due = new Date(reminder.dueAtISO);
  const dueLabel = Number.isFinite(due.getTime())
    ? due.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
      })
    : reminder.dueAtISO;
  return `⏰ Reminder\n\n${reminder.text}\n\n(scheduled for ${dueLabel})`;
}

function loadState(): SchedulerState {
  if (!existsSync(STATE_PATH)) return { version: 1 };
  try {
    const raw = readFileSync(STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SchedulerState>;
    return { version: 1, ...parsed };
  } catch {
    return { version: 1 };
  }
}

function saveState(state: SchedulerState): void {
  try {
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // ignore
  }
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
