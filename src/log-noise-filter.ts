// Deduplicates high-volume, low-signal log lines from two sources:
//   1. libsignal's raw `console.warn("Decrypted message with closed session.")`
//      and similar — emitted once per stale group-session message during
//      reconnect, sometimes hundreds in a burst.
//   2. Baileys' pino logger emitting "failed to decrypt message" and
//      "transaction failed, rolling back" for the same reason.
//
// Strategy: first hit prints immediately with a "(suppressing repeats)"
// note, subsequent hits within `windowMs` only bump a counter. A timer
// flushes counts with a single summary line.

type NoisePattern = {
  match: (msg: string) => boolean;
  label: string;
};

type NoiseState = {
  count: number;
  firstSeenAt: number;
  printedFirst: boolean;
};

const WINDOW_MS = 60_000;
const FLUSH_INTERVAL_MS = 30_000;

const patterns: NoisePattern[] = [
  {
    label: "libsignal: decrypted message with closed session",
    match: (msg) => msg.includes("Decrypted message with closed session")
  },
  {
    label: "libsignal: removing old closed session",
    match: (msg) => msg.includes("Removing old closed session")
  },
  {
    label: "libsignal: session error (bad mac / decrypt)",
    match: (msg) => msg.startsWith("Session error:") || msg.includes("Bad MAC")
  },
  {
    label: "libsignal: failed to decrypt with any known session",
    match: (msg) => msg.includes("Failed to decrypt message with any known session")
  },
  {
    label: "baileys: failed to decrypt message (session/prekey)",
    match: (msg) => msg.includes("failed to decrypt message")
  },
  {
    label: "baileys: transaction failed, rolling back",
    match: (msg) => msg.includes("transaction failed, rolling back")
  },
  {
    label: "baileys: buffer timeout, auto-flushing",
    match: (msg) => msg.includes("Buffer timeout reached, auto-flushing")
  },
  {
    label: "baileys: invalid mex newsletter notification",
    match: (msg) => msg.includes("Invalid mex newsletter notification")
  }
];

const state = new Map<string, NoiseState>();
let flushTimer: ReturnType<typeof setInterval> | null = null;
let installed = false;

function now(): number {
  return Date.now();
}

function bump(label: string): { firstHit: boolean } {
  const existing = state.get(label);
  if (!existing) {
    state.set(label, { count: 1, firstSeenAt: now(), printedFirst: false });
    return { firstHit: true };
  }
  existing.count += 1;
  return { firstHit: false };
}

function flush(): void {
  const ts = new Date().toISOString();
  for (const [label, entry] of state) {
    if (entry.count <= 1) continue;
    const extra = entry.count - (entry.printedFirst ? 1 : 0);
    if (extra <= 0) continue;
    process.stdout.write(`${ts} [noise] ${label} × ${extra} (suppressed)\n`);
    entry.count = 0;
    entry.printedFirst = true;
  }
}

function classify(msg: string): NoisePattern | null {
  for (const pattern of patterns) {
    if (pattern.match(msg)) return pattern;
  }
  return null;
}

function ensureFlushTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
  if (typeof flushTimer === "object" && flushTimer !== null && "unref" in flushTimer) {
    (flushTimer as unknown as { unref: () => void }).unref?.();
  }
}

export function installConsoleNoiseFilter(): void {
  if (installed) return;
  installed = true;

  const originalWarn = console.warn.bind(console);
  const originalInfo = console.info.bind(console);
  const originalLog = console.log.bind(console);
  const originalError = console.error.bind(console);

  const wrap = (original: (...args: unknown[]) => void) => (...args: unknown[]) => {
    for (const arg of args) {
      if (typeof arg !== "string") continue;
      const hit = classify(arg);
      if (!hit) continue;
      const { firstHit } = bump(hit.label);
      if (firstHit) {
        const entry = state.get(hit.label);
        if (entry) entry.printedFirst = true;
        original(`[noise] ${hit.label} (further occurrences suppressed)`);
      }
      ensureFlushTimer();
      return;
    }
    original(...args);
  };

  console.warn = wrap(originalWarn);
  console.info = wrap(originalInfo);
  console.log = wrap(originalLog);
  console.error = wrap(originalError);
  ensureFlushTimer();
}

// Wraps a pino-like logger so known-noise messages on the `warn` and `error`
// channels are counted rather than re-emitted every occurrence. Info/debug/
// trace pass through untouched.
export interface NoiseLogger {
  level: string;
  child(obj: Record<string, unknown>): NoiseLogger;
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export function wrapLoggerWithNoiseFilter(inner: NoiseLogger): NoiseLogger {
  const handle = (
    channel: "warn" | "error",
    obj: unknown,
    msg: string | undefined
  ): boolean => {
    const candidates: string[] = [];
    if (typeof msg === "string") candidates.push(msg);
    if (typeof obj === "string") candidates.push(obj);
    if (obj && typeof obj === "object") {
      const rec = obj as Record<string, unknown>;
      if (typeof rec.msg === "string") candidates.push(rec.msg);
      if (typeof rec.message === "string") candidates.push(rec.message);
      if (rec.err && typeof rec.err === "object") {
        const errMsg = (rec.err as Record<string, unknown>).message;
        if (typeof errMsg === "string") candidates.push(errMsg);
      }
    }
    for (const text of candidates) {
      const hit = classify(text);
      if (!hit) continue;
      const { firstHit } = bump(hit.label);
      if (firstHit) {
        const entry = state.get(hit.label);
        if (entry) entry.printedFirst = true;
        inner[channel](
          { noise: hit.label },
          `[noise] ${hit.label} (further occurrences suppressed)`
        );
      }
      ensureFlushTimer();
      return true;
    }
    return false;
  };

  const wrapped: NoiseLogger = {
    get level() {
      return inner.level;
    },
    set level(next: string) {
      inner.level = next;
    },
    child(meta: Record<string, unknown>): NoiseLogger {
      return wrapLoggerWithNoiseFilter(inner.child(meta) as NoiseLogger);
    },
    trace: (obj: unknown, msg?: string) => inner.trace(obj, msg),
    debug: (obj: unknown, msg?: string) => inner.debug(obj, msg),
    info: (obj: unknown, msg?: string) => inner.info(obj, msg),
    warn: (obj: unknown, msg?: string) => {
      if (handle("warn", obj, msg)) return;
      inner.warn(obj, msg);
    },
    error: (obj: unknown, msg?: string) => {
      if (handle("error", obj, msg)) return;
      inner.error(obj, msg);
    }
  };

  return wrapped;
}
