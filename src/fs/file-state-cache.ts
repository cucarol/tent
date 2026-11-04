import type { BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

export type FileState = {
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  dev: string;
  ino: string;
};
export function fileState(stat: BigIntStats): FileState {
  return {
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
    dev: String(stat.dev),
    ino: String(stat.ino),
  };
}
/** A conservative second covers coarse timestamps even when Node exposes nanoseconds. */
function stateCacheHit(state: FileState, cached: FileState, writtenAtNs: string): boolean {
  return (
    state.size === cached.size &&
    state.mtimeNs === cached.mtimeNs &&
    state.ctimeNs === cached.ctimeNs &&
    state.dev === cached.dev &&
    state.ino === cached.ino &&
    BigInt(state.mtimeNs) < BigInt(writtenAtNs) - 1_000_000_000n
  );
}
type Entry = { state: FileState; writtenAtNs: string; value: unknown };
type Store = { entries: Record<string, Entry>; dirty: boolean };
type ReadScope = {
  values: Map<string, Promise<unknown>>;
  stores: Map<string, Promise<Store>>;
};
const scopes = new AsyncLocalStorage<ReadScope>();
// Bump when what an entry means changes.
const cacheSchema = 2;

/** The scope belongs to one request; nested inspections reuse it, parallel requests do not. */
export async function withFileReadScope<T>(action: () => Promise<T>): Promise<T> {
  if (scopes.getStore()) return action();
  const scope: ReadScope = { values: new Map(), stores: new Map() };
  return scopes.run(scope, async () => {
    try {
      return await action();
    } finally {
      await Promise.all(
        [...scope.stores].map(async ([filename, pending]) => {
          const store = await pending;
          if (!store.dirty) return;
          const temp = `${filename}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
          try {
            await fs.mkdir(path.dirname(filename), { recursive: true });
            await fs.writeFile(
              temp,
              JSON.stringify({ schema: cacheSchema, entries: store.entries }),
            );
            await fs.rename(temp, filename);
          } catch {
            await fs.rm(temp, { force: true }).catch(() => undefined);
          }
        }),
      );
    }
  });
}
export function hasFileReadScope(): boolean {
  return scopes.getStore() !== undefined;
}
export function withoutFileReadScope<T>(action: () => Promise<T>): Promise<T> {
  return scopes.exit(action);
}
export function scopedRead<T>(key: string, read: () => Promise<T>): Promise<T> {
  const scope = scopes.getStore();
  if (!scope) return read();
  let pending = scope.values.get(key) as Promise<T> | undefined;
  if (!pending) {
    pending = read().catch((error) => {
      scope.values.delete(key);
      throw error;
    });
    scope.values.set(key, pending);
  }
  return pending;
}
export function peekScopedRead<T>(key: string): Promise<T> | undefined {
  return scopes.getStore()?.values.get(key) as Promise<T> | undefined;
}
export function forgetScopedReads(): void {
  scopes.getStore()?.values.clear();
}
export function forgetScopedRead(key: string): void {
  scopes.getStore()?.values.delete(key);
}
async function cacheStore(filename: string): Promise<Store> {
  const scope = scopes.getStore()!;
  let pending = scope.stores.get(filename);
  if (!pending) {
    pending = fs
      .readFile(filename, "utf8")
      .then((raw) => {
        const parsed = JSON.parse(raw);
        return { entries: parsed.schema === cacheSchema ? parsed.entries : {}, dirty: false };
      })
      .catch(() => ({ entries: {}, dirty: false }));
    scope.stores.set(filename, pending);
  }
  return pending;
}
export async function cachedFileValue<T>(
  filename: string,
  key: string,
  state: FileState,
): Promise<T | undefined> {
  const entry = (await cacheStore(filename)).entries[key];
  return entry && stateCacheHit(state, entry.state, entry.writtenAtNs)
    ? (entry.value as T)
    : undefined;
}
export async function rememberFileValue(
  filename: string,
  key: string,
  state: FileState,
  value: unknown,
): Promise<void> {
  const store = await cacheStore(filename);
  store.entries[key] = { state, writtenAtNs: String(BigInt(Date.now()) * 1_000_000n), value };
  store.dirty = true;
}
