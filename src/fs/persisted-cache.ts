import * as fs from "node:fs/promises";
import path from "node:path";
import { deserialize, serialize } from "node:v8";
import { renameWithRetry } from "./rename-with-retry.js";

type Scope<V> = <T>(
  previous: Map<string, V>,
  action: () => Promise<T>,
) => Promise<{ result: T; used: Map<string, V> }>;

/**
 * Keep one request's parses for the next. Losing the file costs only a reparse, so an
 * unreadable one counts as empty and a failed save is ignored. Entries are keyed by their
 * exact input; bump the version when what they mean changes.
 */
export async function withPersistedCache<V, T>(
  systemRoot: string,
  name: string,
  version: number,
  scope: Scope<V>,
  action: () => Promise<T>,
): Promise<T> {
  const file = path.join(systemRoot, ".git", "tent-material-cache", name);
  let previous = new Map<string, V>();
  try {
    const saved = deserialize(await fs.readFile(file));
    if (saved.version === version) previous = saved.entries;
  } catch {
    /* Parse again. */
  }
  const { result, used } = await scope(previous, action);
  if ([...used].some(([key, value]) => previous.get(key) !== value)) {
    // A narrow request keeps every other entry; past the bound, the oldest go first.
    const entries = new Map(previous);
    for (const [key, value] of used) {
      entries.delete(key);
      entries.set(key, value);
    }
    while (entries.size > 10_000) entries.delete(entries.keys().next().value!);
    const temp = `${file}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
    try {
      // V8 preserves YAML alias sharing and -0; JSON would silently change those values.
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(temp, serialize({ version, entries }));
      await renameWithRetry(temp, file);
    } catch {
      await fs.rm(temp, { force: true }).catch(() => undefined);
    }
  }
  return result;
}
