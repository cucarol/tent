import type { BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
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
export function sameFileState(a: FileState, b: FileState): boolean {
  return (
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    a.dev === b.dev &&
    a.ino === b.ino
  );
}
export function isFileState(value: unknown): value is FileState {
  if (!value || typeof value !== "object") return false;
  const state = value as FileState;
  return [state.size, state.mtimeNs, state.ctimeNs, state.dev, state.ino].every(
    (v) => typeof v === "string" && /^-?\d+$/.test(v),
  );
}
/** A conservative second covers coarse timestamps even when Node exposes nanoseconds. */
export function stateCacheHit(
  state: FileState,
  cachedState: FileState,
  writtenAtNs: string,
): boolean {
  return (
    /^\d+$/.test(writtenAtNs) &&
    sameFileState(state, cachedState) &&
    BigInt(state.mtimeNs) < BigInt(writtenAtNs) - 1_000_000_000n
  );
}
type Entry = { state: FileState; writtenAtNs: string; value: unknown; digest: string };
type Store = { entries: Record<string, Entry>; dirty: boolean };
type ReadScope = {
  forceContent: boolean;
  values: Map<string, Promise<unknown>>;
  pending: Map<string, Promise<unknown>>;
  stores: Map<string, Promise<Store>>;
};
const scopes = new AsyncLocalStorage<ReadScope>();
// Earlier entries could contain headers not bound to the handle that supplied their bytes.
const cacheSchema = 2;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The scope belongs to one request; nested inspections reuse it, parallel requests do not. */
export async function withFileReadScope<T>(
  action: () => Promise<T>,
  forceContent = false,
): Promise<T> {
  const current = scopes.getStore();
  if (current && !forceContent) return action();
  const scope: ReadScope = {
    forceContent,
    values: new Map(),
    pending: new Map(),
    stores: new Map(),
  };
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
export function forceContentRead(): boolean {
  return scopes.getStore()?.forceContent ?? false;
}
export function hasFileReadScope(): boolean {
  return scopes.getStore() !== undefined;
}
export function withoutFileReadScope<T>(action: () => Promise<T>): Promise<T> {
  return scopes.exit(action);
}
export function scopedPendingRead<T>(key: string, read: () => Promise<T>): Promise<T> {
  const scope = scopes.getStore();
  if (!scope) return read();
  let pending = scope.pending.get(key) as Promise<T> | undefined;
  if (!pending) {
    pending = read().finally(() => {
      if (scope.pending.get(key) === pending) scope.pending.delete(key);
    });
    scope.pending.set(key, pending);
  }
  return pending;
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
  const scope = scopes.getStore();
  if (!scope) throw new Error("File state cache requires a read scope");
  let pending = scope.stores.get(filename);
  if (!pending) {
    pending = fs
      .readFile(filename, "utf8")
      .then((raw) => {
        const parsed = JSON.parse(raw);
        return {
          entries:
            parsed?.schema === cacheSchema &&
            parsed.entries &&
            typeof parsed.entries === "object" &&
            !Array.isArray(parsed.entries)
              ? parsed.entries
              : {},
          dirty: false,
        };
      })
      .catch(() => ({ entries: {}, dirty: false }));
    scope.stores.set(filename, pending);
  }
  return pending;
}
export async function cachedFileValue<T>(
  filename: string | undefined,
  key: string,
  state: FileState,
  valid: (value: unknown) => value is T,
): Promise<T | undefined> {
  if (!filename || forceContentRead()) return undefined;
  const entry = (await cacheStore(filename)).entries[key];
  if (
    !entry ||
    !isFileState(entry.state) ||
    typeof entry.writtenAtNs !== "string" ||
    !stateCacheHit(state, entry.state, entry.writtenAtNs) ||
    !valid(entry.value)
  )
    return undefined;
  if (entry.digest !== digest([entry.state, entry.writtenAtNs, entry.value])) return undefined;
  return entry.value;
}
export async function rememberFileValue(
  filename: string | undefined,
  key: string,
  state: FileState,
  value: unknown,
): Promise<void> {
  if (!filename) return;
  const store = await cacheStore(filename);
  const writtenAtNs = String(BigInt(Date.now()) * 1_000_000n);
  store.entries[key] = { state, writtenAtNs, value, digest: digest([state, writtenAtNs, value]) };
  store.dirty = true;
}
