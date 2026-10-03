import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  processIsAlive,
  releaseMutationLockIfOwned,
  withFileMutationLock,
} from "../../src/fs/mutation-lock.js";

const [root, id, gate, mode] = process.argv.slice(2);
const lockPath = path.join(root, "mutation.lock");
const marker = (stage: string) => path.join(root, `${id}.${stage}`);
const mark = (stage: string, value: unknown = {}) =>
  fs.writeFileSync(marker(stage), JSON.stringify(value));
if (fs.existsSync(`${lockPath}.guard`)) {
  mark("blocked");
  if (mode === "timeout") setImmediate(() => mark("heartbeat"));
}
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const isProcessAlive = (pid: number) => {
  mark("probe", { pid });
  if (gate === "gate") {
    while (!fs.existsSync(marker("release-gate"))) Atomics.wait(sleeper, 0, 0, 10);
  }
  return processIsAlive(pid);
};
const hold = async () => {
  mark("acquired", { pid: process.pid });
  while (!fs.existsSync(marker("release"))) await delay(10);
};
try {
  if (mode === "wrong-release") {
    mark("released", { removed: await releaseMutationLockIfOwned(lockPath, "wrong-owner") });
  } else {
    await withFileMutationLock(lockPath, hold, {
      makeOwnerToken: () => id,
      isProcessAlive,
      staleMs: -1,
      busyMessage: "mutation busy",
      acquireFailedMessage: "mutation acquire failed",
    });
    mark("released");
  }
} catch (error) {
  mark("failed", { message: error instanceof Error ? error.message : String(error) });
}
