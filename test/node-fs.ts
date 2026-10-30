import fs from "node:fs/promises";
import path from "node:path";
import { NodeFs } from "../src/fs/node-fs.js";

const opened = new Map<NodeFs, string>();
/** Test fixtures own adapters just as a CLI command owns its adapter. */
export function openTestFs(...args: ConstructorParameters<typeof NodeFs>): NodeFs {
  const adapter = new NodeFs(...args);
  opened.set(adapter, path.resolve(args[0]));
  return adapter;
}

/** Close all fixture readers before Windows removes their database files. */
export async function removeTestFixture(root: string, options: Parameters<typeof fs.rm>[1]) {
  const resolved = path.resolve(root);
  for (const [adapter, systemRoot] of [...opened]) {
    const relative = path.relative(resolved, systemRoot);
    if (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    ) {
      await adapter.close();
      opened.delete(adapter);
    }
  }
  await fs.rm(root, options);
}
