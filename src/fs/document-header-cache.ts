import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { deserialize, serialize } from "node:v8";
import {
  validFrontmatterCache,
  withFrontmatterCache,
  type FrontmatterCache,
} from "../core/base/frontmatter.js";
import { renameWithRetry } from "./rename-with-retry.js";
import { withFileReadScope } from "./file-state-cache.js";
import { withPersistedMarkdownSyntax } from "./markdown-syntax-cache.js";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest();

/** A brief shares validated file observations and parsed headers, never a complete result. */
export async function withDocumentHeaderCache<T>(systemRoot: string, action: () => Promise<T>) {
  return withFileReadScope(() =>
    withPersistedMarkdownSyntax(systemRoot, () => withParsedHeaders(systemRoot, action)),
  );
}

async function withParsedHeaders<T>(systemRoot: string, action: () => Promise<T>) {
  if (
    !(await fs
      .stat(path.join(systemRoot, ".git"))
      .then((s) => s.isDirectory())
      .catch(() => false))
  )
    return action();
  const directory = path.join(systemRoot, ".git", "tent-material-cache");
  const file = path.join(directory, "document-headers.bin");
  let previous: FrontmatterCache = new Map();
  try {
    const bytes = await fs.readFile(file);
    const payload = bytes.subarray(32);
    if (bytes.subarray(0, 32).equals(digest(payload))) {
      const saved = deserialize(payload);
      // Bump this version when the accepted YAML grammar or parse semantics change.
      if (saved.version === 2 && validFrontmatterCache(saved.entries)) previous = saved.entries;
    }
  } catch {
    /* Missing, corrupt or unreadable cache: the normal parser remains authoritative. */
  }
  const { result, used } = await withFrontmatterCache(previous, action);
  if ([...used].some(([key, value]) => previous.get(key) !== value)) {
    // Metadata-only and narrow UI requests must not erase every other Node's parse.
    const entries = new Map(previous);
    for (const [key, value] of used) {
      entries.delete(key);
      entries.set(key, value);
    }
    while (entries.size > 10_000) entries.delete(entries.keys().next().value!);
    const temp = `${file}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
    try {
      // V8 preserves YAML alias sharing and -0; JSON would silently change those values.
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
