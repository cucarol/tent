import * as fs from "node:fs/promises";
import * as path from "node:path";
import { workspaceDraftReportPath } from "../core/check/workspace-draft.js";
import type { NodeDraftStore } from "../core/write/node-write-draft.js";
import type { NodeWriteBatchInput } from "../core/write/node-write-batch.js";
import { durableReplace } from "./durable-file.js";

/** The draft shrinks as its entries are saved; the last one removes it and its report. */
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
  const raw = await fs.readFile(filename, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`Draft file not found: ${filename}`);
    throw error;
  });
  return {
    input: JSON.parse(raw),
    store: {
      async publish(remaining: NodeWriteBatchInput) {
        if (remaining.items.length) {
          await durableReplace(filename, JSON.stringify(remaining, null, 2) + "\n", "utf8");
          return;
        }
        await fs.rm(workspaceDraftReportPath(filename), { force: true });
        await fs.rm(filename, { force: true });
      },
    },
  };
}
