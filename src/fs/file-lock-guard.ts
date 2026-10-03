import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

type GuardOwner = { token: string; pid: number };

/**
 * Serialize mutation.lock bookkeeping with an exclusive directory.
 * A dead PID permits reclaim; PID reuse can keep a crashed guard busy, so
 * uncertain ownership fails closed after the timeout.
 */
export async function withFileLockGuard<T>(lockPath: string, action: () => Promise<T>): Promise<T> {
  const guardPath = `${lockPath}.guard`;
  const owner: GuardOwner = { token: randomUUID(), pid: process.pid };
  const deadline = performance.now() + 10_000;

  for (;;) {
    // Publish a complete owner record atomically.
    const pending = await fs.mkdtemp(`${guardPath}.pending-`);
    try {
      await fs.writeFile(`${pending}/owner.json`, JSON.stringify(owner));
      await fs.rename(pending, guardPath);
      break;
    } catch (error) {
      await fs.rm(pending, { recursive: true, force: true });
      if (!isOccupied(error)) throw error;
    }

    const current = await readOwner(guardPath);
    if (current && !processIsAlive(current.pid)) {
      // All contenders for this dead owner use the same destination. Its
      // nonempty directory remains as a tombstone, so a delayed contender
      // cannot rename a new holder's guard after another one reclaims it.
      // Tombstones from crashed holders are intentionally retained.
      try {
        await fs.rename(guardPath, `${guardPath}.stale-${current.token}`);
      } catch (error) {
        if (!isOccupied(error) && !isMissing(error)) throw error;
      }
    }
    if (performance.now() >= deadline) {
      throw new Error(
        `Lock bookkeeping guard is still busy: ${guardPath}. Manual cleanup is safe only after all Tent writers have stopped.`,
      );
    }
    await setTimeout(10);
  }

  try {
    return await action();
  } finally {
    const released = `${guardPath}.released-${owner.token}`;
    const releaseDeadline = performance.now() + 1_000;
    for (;;) {
      try {
        await fs.rename(guardPath, released);
        break;
      } catch (error) {
        // Windows can briefly deny directory rename while a contender reads owner.json.
        if (!isAccessDenied(error) || performance.now() >= releaseDeadline) throw error;
        await setTimeout(10);
      }
    }
    await fs.rm(released, { recursive: true, force: true });
  }
}

async function readOwner(guardPath: string): Promise<GuardOwner | undefined> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(`${guardPath}/owner.json`, "utf8"));
    if (
      value &&
      typeof value === "object" &&
      "token" in value &&
      "pid" in value &&
      typeof value.token === "string" &&
      typeof value.pid === "number" &&
      Number.isInteger(value.pid)
    ) {
      return value as GuardOwner;
    }
  } catch (error) {
    if (!isMissing(error) && !(error instanceof SyntaxError)) throw error;
  }
  return undefined;
}

function processIsAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

function isOccupied(error: unknown): boolean {
  return ["EEXIST", "ENOTEMPTY"].some((code) => hasCode(error, code)) || isAccessDenied(error);
}

function isAccessDenied(error: unknown): boolean {
  return hasCode(error, "EPERM") || hasCode(error, "EACCES");
}

function isMissing(error: unknown): boolean {
  return hasCode(error, "ENOENT");
}

function hasCode(error: unknown, code: string): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
