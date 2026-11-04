import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { toNamespacedPath } from "node:path";
import { setTimeout } from "node:timers/promises";

type LockOwner = { token: string; pid: number };

export class FileLockBusyError extends Error {}

/**
 * Cross-process lock: a directory published whole by rename, naming the process that holds it.
 * A dead holder is reclaimed at once and a live one is never evicted, however old. Waiting only
 * retries the acquisition; the action runs once. A disposable record can skip the flush.
 */
export async function withFileLock<T>(
  lock: string,
  action: () => Promise<T>,
  {
    waitMs = 10_000,
    flush = true,
    busyMessage,
  }: { waitMs?: number; flush?: boolean; busyMessage?: string } = {},
): Promise<T> {
  const owner: LockOwner = { token: randomUUID(), pid: process.pid };
  const deadline = performance.now() + waitMs;
  let nextOwnerCheck = 0;

  for (;;) {
    if (!(await exists(lock))) {
      if (await publish(lock, owner, flush)) break;
    } else if (performance.now() >= nextOwnerCheck) {
      // Reading owner.json blocks the holder's release on Windows, so a waiter reads it rarely.
      nextOwnerCheck = performance.now() + 200;
      const current = await readOwner(lock);
      if (current && !processIsAlive(current.pid)) {
        // All contenders for this dead owner use the same destination. Its
        // nonempty directory remains as a tombstone, so a delayed contender
        // cannot rename a new holder's lock after another one reclaims it.
        try {
          await fs.rename(lock, `${lock}.stale-${current.token}`);
          continue;
        } catch (error) {
          if (!isOccupied(error) && !isMissing(error)) throw error;
        }
      }
    }
    if (performance.now() >= deadline)
      throw new FileLockBusyError(busyMessage ?? `File lock is still busy: ${lock}.`);
    await setTimeout(10);
  }

  try {
    return await action();
  } finally {
    const released = `${lock}.released-${owner.token}`;
    const releaseDeadline = performance.now() + 5_000;
    for (;;) {
      try {
        await fs.rename(lock, released);
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

/** The graph's one write lock. */
export function withMutationLock<T>(lock: string, action: () => Promise<T>): Promise<T> {
  return withFileLock(lock, action, {
    waitMs: 8_000,
    busyMessage: `Tent mutation lock is still busy after waiting 8 seconds: ${lock}. Wait for the other write to finish; if no Tent command is running, delete that directory.`,
  });
}

const exists = (lock: string) =>
  fs.stat(lock).then(
    () => true,
    (error) => {
      if (isMissing(error)) return false;
      throw error;
    },
  );

/** Publish a complete owner record atomically; false when another holder got there first. */
async function publish(lock: string, owner: LockOwner, flush: boolean): Promise<boolean> {
  const pending = await fs.mkdtemp(toNamespacedPath(`${lock}.pending-`));
  try {
    await fs.writeFile(`${pending}/owner.json`, JSON.stringify(owner), { flush });
    await fs.rename(pending, lock);
    return true;
  } catch (error) {
    await fs.rm(pending, { recursive: true, force: true });
    if (!isOccupied(error)) throw error;
    return false;
  }
}

async function readOwner(lock: string): Promise<LockOwner | undefined> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(`${lock}/owner.json`, "utf8"));
    if (
      value &&
      typeof value === "object" &&
      "token" in value &&
      "pid" in value &&
      typeof value.token === "string" &&
      typeof value.pid === "number" &&
      Number.isInteger(value.pid)
    ) {
      return value as LockOwner;
    }
  } catch (error) {
    if (!isMissing(error) && !(error instanceof SyntaxError)) throw error;
  }
  return undefined;
}

/** Permission failures count as alive. */
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
