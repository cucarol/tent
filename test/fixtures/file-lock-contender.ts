import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { withFileLock } from "../../src/fs/file-lock.js";

const [root, mode, rounds] = process.argv.slice(2) as [string, "count" | "hold", string];
const lock = path.join(root, "test.lock");

if (mode === "hold") {
  await withFileLock(lock, async () => {
    fs.writeFileSync(path.join(root, "held"), "");
    for (;;) await delay(1_000);
  });
} else {
  // Read, wait, then write: without exclusion, processes overwrite each other's increments.
  const counter = path.join(root, "counter");
  for (let i = 0; i < Number(rounds); i++)
    await withFileLock(
      lock,
      async () => {
        const value = Number(fs.readFileSync(counter, "utf8"));
        await delay(1);
        fs.writeFileSync(counter, String(value + 1));
      },
      { waitMs: 60_000 },
    );
}
