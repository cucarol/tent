import type { FsAdapter } from "../core/adapter.js";

/** Share overlapping identical reads; a settled read is never reused by a later query. */
export function shareInFlightReads(fs: FsAdapter): FsAdapter {
  const pending = new Map<string, Promise<unknown>>();
  const methods = new Set(["readFile", "readBinary", "readFrontmatter", "exists", "listDir"]);
  return new Proxy(fs, {
    get(target, property) {
      const method: unknown = Reflect.get(target, property);
      if (typeof method !== "function") return method;
      if (!methods.has(String(property))) return method.bind(target);
      return (path: string) => {
        const key = JSON.stringify([property, path]);
        let reading = pending.get(key);
        if (!reading) {
          reading = (async () => {
            try {
              return await method.call(target, path);
            } finally {
              pending.delete(key);
            }
          })();
          pending.set(key, reading);
        }
        return reading;
      };
    },
  });
}
