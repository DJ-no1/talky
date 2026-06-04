/**
 * Claude mediator watcher — blocks until WhatsApp events are pending, then prints
 * them as JSON and exits. Designed to be run in the background by a Claude Code
 * session (`bun scripts/wait-for-events.ts`): the process exiting is the wake-up
 * signal that new messages need handling.
 *
 * Exit codes: 0 = events pending (JSON on stdout), 2 = timed out with no events.
 *
 * Usage:
 *   bun scripts/wait-for-events.ts [--timeout-seconds 3600] [--poll-ms 1500]
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const PENDING_PATH = path.join(process.cwd(), "data", "claude", "pending.jsonl");

function argValue(flag: string, fallback: number): number {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  const parsed = Number.parseInt(process.argv[index + 1] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const timeoutSeconds = argValue("--timeout-seconds", 3600);
const pollMs = argValue("--poll-ms", 1500);

function readPending(): unknown[] {
  if (!existsSync(PENDING_PATH)) return [];
  const events: unknown[] = [];
  for (const line of readFileSync(PENDING_PATH, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // skip corrupt line
    }
  }
  return events;
}

const deadline = Date.now() + timeoutSeconds * 1000;

async function main(): Promise<void> {
  for (;;) {
    const pending = readPending();
    if (pending.length > 0) {
      console.log(JSON.stringify({ pendingCount: pending.length, events: pending }, null, 2));
      process.exit(0);
    }
    if (Date.now() >= deadline) {
      console.log(JSON.stringify({ timeout: true, pendingCount: 0 }));
      process.exit(2);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

void main();
