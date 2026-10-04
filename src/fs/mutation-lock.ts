// Cross-process Tent mutation.lock with ownership tokens.
// Release only removes a lock that still belongs to this holder under an
// exclusive guard directory,
// and age-only stale reclaim is refused while the recorded PID is still alive.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { withFileLockGuard } from "./file-lock-guard.js";

/** Lock older than this may be reclaimed when its PID is absent/unusable. */
export const MUTATION_LOCK_STALE_MS = 120_000;

export interface MutationLockRecord {
  ownerToken: string;
  pid: number;
  createdAt: string;
}

export interface WithFileMutationLockOptions {
  /** Wait only for acquisition; the action is never retried. Defaults to fail-fast. */
  waitMs?: number;
  /** Busy error when a non-stale lock is held. */
  busyMessage: string;
  /** Thrown when acquire fails after reclaim attempts. */
  acquireFailedMessage: string;
  /** Override for tests. */
  now?: () => number;
  /** Override for tests. */
  makeOwnerToken?: () => string;
  /** Stale threshold in ms (default 120s). */
  staleMs?: number;
  /**
   * Process liveness probe for reclaim. Default: kill(pid, 0).
   * EPERM / success = alive; ESRCH / invalid pid = absent.
   */
  isProcessAlive?: (pid: number) => boolean;
}

/**
 * Acquire `lockPath` with `wx`, run `action`, release only if ownership matches.
 * An exclusive guard directory serializes owner checks, reclaim, publication
 * and release. A crashed guard holder is reclaimed only when its PID is absent;
 * PID reuse can leave the guard busy until a writer safely resolves it.
 * Age alone is not enough: a live recorded PID keeps the lock busy.
 */
export async function withFileMutationLock<T>(
  lockPath: string,
  action: () => Promise<T>,
  options: WithFileMutationLockOptions,
): Promise<T> {
  const now = options.now ?? Date.now;
  const makeOwnerToken = options.makeOwnerToken ?? randomUUID;
  const staleMs = options.staleMs ?? MUTATION_LOCK_STALE_MS;
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  const ownerToken = makeOwnerToken();
  const record: MutationLockRecord = {
    ownerToken,
    pid: process.pid,
    createdAt: new Date(now()).toISOString(),
  };

  await fs.mkdir(dirnameOf(lockPath), { recursive: true });

  let handle: FileHandle | undefined;
  const deadline = performance.now() + (options.waitMs ?? 0);
  for (;;) {
    try {
      await withFileLockGuard(lockPath, async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            handle = await fs.open(lockPath, "wx");
            break;
          } catch (error) {
            if (!isAlreadyExists(error)) throw error;
            const reclaimable = await mayReclaimLock(lockPath, now, staleMs, isProcessAlive);
            if (!reclaimable || attempt >= 2) {
              throw new MutationLockBusyError(options.busyMessage);
            }
            // The guard prevents another owner from publishing between check and move.
            const quarantine = `${lockPath}.stale-${randomUUID()}`;
            try {
              await fs.rename(lockPath, quarantine);
              await fs.rm(quarantine, { force: true }).catch(() => undefined);
            } catch (renameError) {
              if (isNotFound(renameError)) continue;
              throw renameError;
            }
          }
        }
        if (!handle) throw new Error(options.acquireFailedMessage);
        try {
          await handle.writeFile(JSON.stringify(record), "utf8");
        } catch (error) {
          await handle.close().catch(() => undefined);
          await fs.rm(lockPath, { force: true });
          throw error;
        }
      });
      break;
    } catch (error) {
      if (!(error instanceof MutationLockBusyError) || performance.now() >= deadline) throw error;
      await setTimeout(Math.min(50, Math.max(1, deadline - performance.now())));
    }
  }

  try {
    return await action();
  } finally {
    await handle?.close().catch(() => undefined);
    await releaseMutationLockIfOwned(lockPath, ownerToken);
  }
}

class MutationLockBusyError extends Error {}

/**
 * Remove lock only when the file still belongs to this holder.
 * The same guard used by acquire keeps ownership stable through removal.
 */
export async function releaseMutationLockIfOwned(
  lockPath: string,
  ownerToken: string,
): Promise<boolean> {
  return withFileLockGuard(lockPath, async () => {
    const current = await readMutationLockRecord(lockPath);
    if (current?.ownerToken !== ownerToken) return false;
    await fs.rm(lockPath, { force: true });
    return true;
  });
}

export async function readMutationLockRecord(lockPath: string): Promise<MutationLockRecord | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const value = JSON.parse(raw) as Partial<MutationLockRecord>;
    if (
      typeof value.ownerToken !== "string" ||
      !value.ownerToken ||
      typeof value.pid !== "number" ||
      !Number.isInteger(value.pid) ||
      typeof value.createdAt !== "string"
    ) {
      return null;
    }
    return value as MutationLockRecord;
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return null;
    return null;
  }
}

/**
 * Reclaim only when the lock is aged AND its PID is absent/unusable.
 * Live PID (including EPERM) blocks reclaim even past the age window.
 * Malformed bodies with a usable live PID stay busy; no usable PID + aged → reclaim.
 */
export async function mayReclaimLock(
  lockPath: string,
  now: () => number = Date.now,
  staleMs: number = MUTATION_LOCK_STALE_MS,
  isProcessAliveFn: (pid: number) => boolean = processIsAlive,
): Promise<boolean> {
  let mtimeMs: number;
  try {
    const stat = await fs.stat(lockPath);
    mtimeMs = stat.mtimeMs;
  } catch (error) {
    // Missing path: contender should retry wx, not quarantine.
    if (isNotFound(error)) return false;
    // Unstatable aged? Treat as reclaimable only if we cannot prove a live owner.
    return true;
  }

  if (now() - mtimeMs <= staleMs) {
    return false;
  }

  const pid = await readRecordedPid(lockPath);
  if (pid !== null && isProcessAliveFn(pid)) {
    return false;
  }
  // Aged + (no usable pid | dead pid) → reclaim.
  return true;
}

/**
 * Best-effort PID from a lock body, independent of any damaged ownership fields.
 * A usable live PID still blocks reclamation.
 */
async function readRecordedPid(lockPath: string): Promise<number | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const value = JSON.parse(raw) as { pid?: unknown };
    if (typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0) {
      return value.pid;
    }
    return null;
  } catch {
    return null;
  }
}

/** Permission failures count as alive. */
export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH = gone. Permission failures are conservatively live.
    return !hasCode(error, "ESRCH");
  }
}

function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i === -1 ? "." : p.slice(0, i);
}

function isAlreadyExists(error: unknown): boolean {
  return hasCode(error, "EEXIST");
}

function isNotFound(error: unknown): boolean {
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
