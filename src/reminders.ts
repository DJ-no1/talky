import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "./config";

export type Reminder = {
  id: string;
  ownerJid: string;
  text: string;
  dueAtISO: string;
  createdAtISO: string;
  notified: boolean;
  notifiedAtISO?: string;
  sourceMessagePreview?: string;
  targetJid?: string;
};

const REMINDERS_PATH = path.join(DATA_DIR, "reminders.json");

type ReminderFile = {
  version: 1;
  reminders: Reminder[];
};

function loadFile(): ReminderFile {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(REMINDERS_PATH)) {
    return { version: 1, reminders: [] };
  }
  try {
    const raw = readFileSync(REMINDERS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ReminderFile>;
    if (!parsed || !Array.isArray(parsed.reminders)) {
      return { version: 1, reminders: [] };
    }
    return { version: 1, reminders: parsed.reminders.filter(isValidReminder) };
  } catch {
    return { version: 1, reminders: [] };
  }
}

function writeFile(file: ReminderFile): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(REMINDERS_PATH, JSON.stringify(file, null, 2), "utf-8");
}

function isValidReminder(value: unknown): value is Reminder {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<Reminder>;
  return (
    typeof r.id === "string" &&
    typeof r.ownerJid === "string" &&
    typeof r.text === "string" &&
    typeof r.dueAtISO === "string" &&
    typeof r.createdAtISO === "string" &&
    typeof r.notified === "boolean"
  );
}

export function listReminders(ownerJid?: string): Reminder[] {
  const file = loadFile();
  const rows = ownerJid
    ? file.reminders.filter((r) => r.ownerJid === ownerJid)
    : file.reminders.slice();
  rows.sort((a, b) => Date.parse(a.dueAtISO) - Date.parse(b.dueAtISO));
  return rows;
}

export function listPendingDue(nowMs = Date.now()): Reminder[] {
  return loadFile()
    .reminders.filter(
      (r) => !r.notified && Number.isFinite(Date.parse(r.dueAtISO)) && Date.parse(r.dueAtISO) <= nowMs
    )
    .sort((a, b) => Date.parse(a.dueAtISO) - Date.parse(b.dueAtISO));
}

export function addReminder(input: {
  ownerJid: string;
  text: string;
  dueAtISO: string;
  sourceMessagePreview?: string;
  targetJid?: string;
}): Reminder {
  const reminder: Reminder = {
    id: crypto.randomBytes(6).toString("hex"),
    ownerJid: input.ownerJid,
    text: input.text.trim(),
    dueAtISO: input.dueAtISO,
    createdAtISO: new Date().toISOString(),
    notified: false,
    sourceMessagePreview: input.sourceMessagePreview,
    targetJid: input.targetJid
  };
  const file = loadFile();
  file.reminders.push(reminder);
  writeFile(file);
  return reminder;
}

export function markReminderNotified(id: string): void {
  const file = loadFile();
  let changed = false;
  for (const reminder of file.reminders) {
    if (reminder.id === id && !reminder.notified) {
      reminder.notified = true;
      reminder.notifiedAtISO = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) writeFile(file);
}

export function cancelReminder(id: string, ownerJid?: string): boolean {
  const file = loadFile();
  const before = file.reminders.length;
  file.reminders = file.reminders.filter(
    (r) => !(r.id === id && (!ownerJid || r.ownerJid === ownerJid))
  );
  if (file.reminders.length === before) return false;
  writeFile(file);
  return true;
}

export function pruneOldReminders(olderThanDays = 30): number {
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const file = loadFile();
  const before = file.reminders.length;
  file.reminders = file.reminders.filter((r) => {
    if (!r.notified) return true;
    const notifiedAt = Date.parse(r.notifiedAtISO ?? r.dueAtISO);
    return Number.isFinite(notifiedAt) ? notifiedAt > cutoff : true;
  });
  const removed = before - file.reminders.length;
  if (removed > 0) writeFile(file);
  return removed;
}

export type ParsedReminder = {
  text: string;
  dueAtISO: string;
  confidence: number;
};

export function parseReminderHeuristic(
  input: string,
  now = new Date()
): ParsedReminder | null {
  const normalized = input.trim();
  if (!normalized) return null;

  const atMatch = normalized.match(
    /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i
  );
  const inMatch = normalized.match(
    /\bin\s+(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?)\b/i
  );
  const tomorrowMatch = /\btomorrow\b/i.test(normalized);
  const todayMatch = /\btoday\b/i.test(normalized);
  const tonightMatch = /\btonight\b/i.test(normalized);
  const dateMatch = normalized.match(
    /\b(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?\b/
  );

  let due: Date | null = null;

  if (dateMatch) {
    const year = Number(dateMatch[1]);
    const month = Number(dateMatch[2]) - 1;
    const day = Number(dateMatch[3]);
    const hour = dateMatch[4] ? Number(dateMatch[4]) : 9;
    const minute = dateMatch[5] ? Number(dateMatch[5]) : 0;
    due = new Date(year, month, day, hour, minute, 0, 0);
  } else if (inMatch) {
    const amount = Number(inMatch[1]);
    const unit = inMatch[2]?.toLowerCase() ?? "minutes";
    const ms =
      unit.startsWith("hour") || unit.startsWith("hr")
        ? amount * 60 * 60 * 1000
        : unit.startsWith("day")
        ? amount * 24 * 60 * 60 * 1000
        : unit.startsWith("week")
        ? amount * 7 * 24 * 60 * 60 * 1000
        : amount * 60 * 1000;
    due = new Date(now.getTime() + ms);
  } else if (atMatch) {
    const hour12 = Number(atMatch[1]);
    const minute = atMatch[2] ? Number(atMatch[2]) : 0;
    const meridiem = atMatch[3]?.toLowerCase();
    let hour = hour12 % 12;
    if (meridiem === "pm") hour += 12;
    due = new Date(now);
    due.setHours(hour, minute, 0, 0);
    if (tomorrowMatch) {
      due.setDate(due.getDate() + 1);
    } else if (due.getTime() <= now.getTime() + 60_000 && !todayMatch && !tonightMatch) {
      due.setDate(due.getDate() + 1);
    }
  } else if (tonightMatch) {
    due = new Date(now);
    due.setHours(21, 0, 0, 0);
    if (due.getTime() <= now.getTime()) due.setDate(due.getDate() + 1);
  } else if (tomorrowMatch) {
    due = new Date(now);
    due.setDate(due.getDate() + 1);
    due.setHours(9, 0, 0, 0);
  }

  if (!due || !Number.isFinite(due.getTime())) return null;

  const reminderText = cleanReminderText(normalized);
  if (!reminderText) return null;

  return {
    text: reminderText,
    dueAtISO: due.toISOString(),
    confidence: dateMatch || inMatch ? 0.9 : atMatch ? 0.8 : 0.6
  };
}

function cleanReminderText(input: string): string {
  let text = input;
  text = text.replace(
    /^\s*(?:please\s+)?remind\s+(?:me\s+)?(?:to\s+)?/i,
    ""
  );
  text = text.replace(
    /\b(?:at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/gi,
    ""
  );
  text = text.replace(
    /\bin\s+\d+(?:\.\d+)?\s*(?:minutes?|mins?|hours?|hrs?|days?|weeks?)\b/gi,
    ""
  );
  text = text.replace(
    /\b(?:tomorrow|today|tonight)\b/gi,
    ""
  );
  text = text.replace(/\b\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?\b/g, "");
  return text.replace(/\s+/g, " ").trim();
}

export function formatReminderSummary(reminder: Reminder): string {
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
  return `${reminder.id} • ${dueLabel} • ${reminder.text}`;
}
