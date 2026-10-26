import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sqliteNotice = "SQLite is an experimental feature and might change at any time";

function loadSqlite(): typeof import("node:sqlite") {
  const emit = process.emitWarning;
  // Node emits this notice synchronously while loading the built-in module. Scope
  // the exact-message filter to that synchronous load; all other warnings survive.
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const type =
      typeof args[0] === "string" ? args[0] : (args[0] as { type?: string } | undefined)?.type;
    if (warning === sqliteNotice && type === "ExperimentalWarning") return;
    Reflect.apply(emit, process, [warning, ...args]);
  }) as typeof process.emitWarning;
  try {
    return require("node:sqlite") as typeof import("node:sqlite");
  } finally {
    process.emitWarning = emit;
  }
}

export type DatabaseSync = import("node:sqlite").DatabaseSync;
export type { SQLInputValue } from "node:sqlite";
export const DatabaseSync = loadSqlite().DatabaseSync;
