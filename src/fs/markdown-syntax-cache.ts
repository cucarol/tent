import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { deserialize, serialize } from "node:v8";
import {
  validMarkdownSyntaxCache,
  withMarkdownSyntaxCache,
  type MarkdownSyntaxCache,
} from "../core/base/markdown-syntax.js";
import { renameWithRetry } from "./rename-with-retry.js";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest();

/** Disposable exact-body syntax; no filesystem observations or resolved Node links. */
export async function withPersistedMarkdownSyntax<T>(systemRoot: string, action: () => Promise<T>) {
  const directory = path.join(systemRoot, ".git", "tent-material-cache");
  if (
    !(await fs
      .stat(path.dirname(directory))
      .then((stat) => stat.isDirectory())
      .catch(() => false))
  )
    return action();
  const file = path.join(directory, "markdown-syntax.bin");
  let previous: MarkdownSyntaxCache = new Map();
  try {
    const bytes = await fs.readFile(file);
    const payload = bytes.subarray(32);
    if (bytes.subarray(0, 32).equals(digest(payload))) {
      const saved = deserialize(payload);
      // Bump whenever the Markdown grammar, span or extraction semantics change.
      if (saved?.version === 2 && validMarkdownSyntaxCache(saved.entries)) previous = saved.entries;
    }
  } catch {
    /* Invalid caches never replace the parser. */
  }
  const { result, used } = await withMarkdownSyntaxCache(previous, action);
  if ([...used].some(([key, value]) => previous.get(key) !== value)) {
    // A narrow read must not evict every other Node. Bound retained syntax and
    // prefer the entries observed by this request when old bodies accumulate.
    const entries = new Map(previous);
    for (const [key, value] of used) {
      entries.delete(key);
      entries.set(key, value);
    }
    while (entries.size > 10_000) entries.delete(entries.keys().next().value!);
    const temp = `${file}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
    try {
      const payload = serialize({ version: 2, entries });
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(temp, Buffer.concat([digest(payload), payload]));
      await renameWithRetry(temp, file);
    } catch {
      await fs.rm(temp, { force: true }).catch(() => undefined);
    }
  }
  return result;
}
