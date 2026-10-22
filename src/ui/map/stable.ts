import { useCallback, useRef } from "react";

/**
 * Equal by value, a few levels down: numbers, strings and the like by value, arrays and plain objects by
 * their entries. Deeper than `depth`, or anything else, only by identity.
 */
export function sameValue(a: unknown, b: unknown, depth = 4): boolean {
  if (Object.is(a, b)) return true;
  if (depth === 0 || typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => sameValue(v, b[i], depth - 1));
  }
  if (Array.isArray(b) || Object.getPrototypeOf(a) !== Object.prototype) return false;
  if (Object.getPrototypeOf(b) !== Object.prototype) return false;
  const ka = Object.keys(a),
    kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const rb = b as Record<string, unknown>;
  return ka.every((k) => k in rb && sameValue((a as Record<string, unknown>)[k], rb[k], depth - 1));
}

/**
 * Keeps the objects of the last list that equal their new ones by id, so the map hands its renderer the
 * same object for every card that did not change, and only changed cards draw again. Returns the last list
 * itself when nothing changed.
 */
export function keepUnchanged<T extends { id: string }>() {
  let last: T[] = [];
  let byId = new Map<string, T>();
  return (next: T[]): T[] => {
    let changed = next.length !== last.length;
    const out = next.map((item, i) => {
      const old = byId.get(item.id);
      const kept = old && sameValue(old, item) ? old : item;
      if (kept !== last[i]) changed = true;
      return kept;
    });
    if (!changed) return last;
    last = out;
    byId = new Map(out.map((item) => [item.id, item]));
    return out;
  };
}

/**
 * A handler that keeps one identity for the life of the component and always runs the latest `fn`. The map
 * hands its node handlers to every card, so a new function on each render would draw every card again.
 */
export function useSteady<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn);
  latest.current = fn;
  return useCallback((...args: A) => latest.current(...args), []);
}
