import * as fs from "node:fs/promises";
import * as path from "node:path";
import { workspaceDraftReportPath } from "../core/check/workspace-draft.js";
import type { NodeDraftStore } from "../core/write/node-write-draft.js";
import type { NodeWriteBatchInput } from "../core/write/node-write-batch.js";
import { durableReplace, syncDirectory } from "./durable-file.js";

async function text(filename: string): Promise<string | null> {
  try {
    return await fs.readFile(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** External planning files participate in ordinary rollback, outside retained document history. */
export async function openNodeDraft(
  filename: string,
  systemRoot: string,
): Promise<{
  input: unknown;
  store: NodeDraftStore;
}> {
  const parent = await fs.realpath(path.dirname(filename));
  const system = await fs.realpath(systemRoot);
  const relative = path.relative(system, parent);
  if (
    !relative ||
    (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))
  )
    throw new Error("Draft must be outside .tent");
  const report = workspaceDraftReportPath(filename);
  for (const file of [filename, report]) {
    const info = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (info && !info.isFile()) throw new Error(`Draft artifact must be a regular file: ${file}`);
  }
  let before = await text(filename);
  if (before === null) throw new Error(`Draft file not found: ${filename}`);
  const reportBefore = await text(report);
  let attempted: { path: string; before: string | null; after: string | null }[] = [];
  async function replace(file: string, expected: string | null, after: string | null) {
    if ((await text(file)) !== expected) throw new Error(`Draft file changed: ${file}`);
    attempted.push({ path: file, before: expected, after });
    if (after === null) {
      if (expected !== null) await fs.unlink(file);
      await syncDirectory(path.dirname(file));
    } else await durableReplace(file, after, "utf8");
  }
  return {
    input: JSON.parse(before),
    store: {
      async publish(remaining: NodeWriteBatchInput) {
        attempted = [];
        if (remaining.items.length) {
          const next = JSON.stringify(remaining, null, 2) + "\n";
          await replace(filename, before, next);
          before = next;
        } else {
          await replace(report, reportBefore, null);
          await replace(filename, before, null);
          before = null;
        }
      },
      async rollback() {
        const failures: unknown[] = [];
        for (const item of [...attempted].reverse()) {
          try {
            const current = await text(item.path);
            if (current === item.before) continue;
            if (current !== item.after)
              throw new Error(`Draft rollback preserved an external edit: ${item.path}`);
            if (item.before === null) {
              await fs.unlink(item.path);
              await syncDirectory(path.dirname(item.path));
            } else await durableReplace(item.path, item.before, "utf8");
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length) throw new AggregateError(failures, failures.map(String).join("; "));
        before = await text(filename);
      },
    },
  };
}
