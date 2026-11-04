import { existsSync, mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { NodeFs } from "../src/fs/node-fs.js";
import { HISTORY_SCHEMA } from "../src/fs/sqlite-history.js";
import { DatabaseSync } from "../src/fs/sqlite-runtime.js";

/** Every Tent has a history, so a fixture's does too. Synchronous, and no fsync: fixtures are many. */
export function ensureTestHistory(systemRoot: string): void {
  const file = path.join(systemRoot, ".git/history.sqlite");
  if (existsSync(file)) return;
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA synchronous=OFF");
  db.exec(HISTORY_SCHEMA);
  db.close();
}

const opened = new Map<NodeFs, string>();
/** Test fixtures own adapters just as a CLI command owns its adapter. */
export function openTestFs(...args: ConstructorParameters<typeof NodeFs>): NodeFs {
  ensureTestHistory(path.resolve(args[0]));
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
