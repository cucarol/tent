import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { serialize, deserialize } from "node:v8";
import * as z from "zod/v4";
import { structureDependenciesSchema } from "../core/base/structure-material.js";
import { renameWithRetry } from "./rename-with-retry.js";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest();
const version = z.string().regex(/^[a-f0-9]{64}$/);
const entrySchema = z.strictObject({
  base: version,
  additional: z.array(z.tuple([z.string(), version])),
  dependencies: structureDependenciesSchema,
});
export type StructureDerivedEntry = z.infer<typeof entrySchema>;
export type StructureDerivedStore = {
  entries: Map<string, StructureDerivedEntry>;
  dirty: boolean;
};

/** Input digests describe live validated source versions, not Git HEAD. */
export async function loadStructureDerivedStore(directory: string): Promise<StructureDerivedStore> {
  try {
    const bytes = await fs.readFile(path.join(directory, "structure-derived.bin"));
    const payload = bytes.subarray(32);
    if (!bytes.subarray(0, 32).equals(digest(payload))) throw new Error("Invalid cache digest");
    const saved = deserialize(payload);
    // Bump when any import resolver or structure dependency rule changes.
    if (saved?.version !== 1 || !(saved.entries instanceof Map)) throw new Error("Invalid cache");
    const entries = new Map<string, StructureDerivedEntry>();
    for (const [key, value] of saved.entries) {
      if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid key");
      const entry = entrySchema.parse(value);
      if (new Set(entry.additional.map(([file]) => file)).size !== entry.additional.length)
        throw new Error("Duplicate source");
      entries.set(key, entry);
    }
    return { entries, dirty: false };
  } catch {
    return { entries: new Map(), dirty: false };
  }
}

export async function saveStructureDerivedStore(directory: string, store: StructureDerivedStore) {
  if (!store.dirty) return;
  while (store.entries.size > 10_000) store.entries.delete(store.entries.keys().next().value!);
  const file = path.join(directory, "structure-derived.bin");
  const temp = `${file}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
  try {
    const payload = serialize({ version: 1, entries: store.entries });
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(temp, Buffer.concat([digest(payload), payload]));
    await renameWithRetry(temp, file);
  } catch {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}
