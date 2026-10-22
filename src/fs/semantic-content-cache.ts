import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { deserialize, serialize } from "node:v8";
import {
  validSemanticContentCache,
  withSemanticContentCache,
  type SemanticContentCache,
} from "../core/base/semantic-content-cache.js";
import { renameWithRetry } from "./rename-with-retry.js";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest();

/** Disposable semantic bytes keyed by all current semantic inputs, including Node identities. */
export async function withPersistedSemanticContent<T>(
  systemRoot: string,
  action: () => Promise<T>,
) {
  const directory = path.join(systemRoot, ".git", "tent-material-cache");
  if (
    !(await fs
      .stat(path.dirname(directory))
      .then((stat) => stat.isDirectory())
      .catch(() => false))
  )
    return action();
  const file = path.join(directory, "semantic-content.bin");
  let previous: SemanticContentCache = new Map();
  try {
    const bytes = await fs.readFile(file);
    const payload = bytes.subarray(32);
    if (bytes.subarray(0, 32).equals(digest(payload))) {
      const saved = deserialize(payload);
      // Bump whenever canonical semantic content rules change.
      if (saved?.version === 1 && validSemanticContentCache(saved.entries))
        previous = saved.entries;
    }
  } catch {
    /* Invalid caches never replace semantic computation. */
  }
  const { result, used } = await withSemanticContentCache(previous, action);
  if ([...used].some(([key, value]) => previous.get(key) !== value)) {
    // Narrow reads retain other Nodes, preferring the latest observed inputs.
    const entries = new Map(previous);
    for (const [key, value] of used) {
      entries.delete(key);
      entries.set(key, value);
    }
    while (entries.size > 10_000) entries.delete(entries.keys().next().value!);
    const temp = `${file}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
    try {
      const payload = serialize({ version: 1, entries });
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(temp, Buffer.concat([digest(payload), payload]));
      await renameWithRetry(temp, file);
    } catch {
      await fs.rm(temp, { force: true }).catch(() => undefined);
    }
  }
  return result;
}
