import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

function isPidRunning(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireProcessLock(lockPath: string): () => void {
  if (existsSync(lockPath)) {
    const raw = readFileSync(lockPath, "utf-8").trim();
    const pid = Number(raw);
    if (isPidRunning(pid)) {
      throw new Error(
        `Another Talky WA session is running (pid=${pid}). Stop it before starting another command.`
      );
    }
    unlinkSync(lockPath);
  }

  writeFileSync(lockPath, String(process.pid), { encoding: "utf-8", flag: "wx" });

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      if (existsSync(lockPath)) {
        const raw = readFileSync(lockPath, "utf-8").trim();
        if (Number(raw) === process.pid) {
          unlinkSync(lockPath);
        }
      }
    } catch {
      // no-op
    }
  };

  process.once("exit", release);
  process.once("SIGINT", () => {
    release();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    release();
    process.exit(143);
  });

  return release;
}
