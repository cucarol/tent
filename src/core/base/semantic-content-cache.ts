import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

export type SemanticContentCache = Map<string, string>;
const caches = new AsyncLocalStorage<{
  previous: SemanticContentCache;
  used: SemanticContentCache;
}>();

export async function withSemanticContentCache<T>(
  previous: SemanticContentCache,
  action: () => Promise<T>,
) {
  const used: SemanticContentCache = new Map();
  const result = await caches.run({ previous, used }, action);
  return { result, used };
}

export function cachedSemanticContent(inputs: () => unknown, compute: () => string): string {
  const cache = caches.getStore();
  if (!cache) return compute();
  const key = createHash("sha256").update(JSON.stringify(inputs())).digest("hex");
  const value = cache.used.get(key) ?? cache.previous.get(key) ?? compute();
  cache.used.set(key, value);
  return value;
}

export function validSemanticContentCache(value: unknown): value is SemanticContentCache {
  return (
    value instanceof Map &&
    [...value].every(
      ([key, content]) =>
        typeof key === "string" && /^[a-f0-9]{64}$/.test(key) && typeof content === "string",
    )
  );
}
