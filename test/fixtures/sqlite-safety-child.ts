import fs from "node:fs/promises";
import path from "node:path";
import { NodeFs } from "../../src/fs/node-fs.js";
import { writeNodesBatch } from "../../src/core/write/node-write-batch.js";
import { readNodeForEdit } from "../../src/core/read/node-query.js";
import { SqliteDocumentHistory } from "../../src/core/store/sqlite-history.js";

const [workspace, cut] = process.argv.slice(2) as [string, string];
async function checkpoint(point: string) {
  if (point !== cut) return;
  process.send?.({ point, pid: process.pid });
  await new Promise<void>(() => setInterval(() => {}, 1000));
}
const root = path.join(workspace, ".tent"),
  history = new SqliteDocumentHistory(root, "core", checkpoint),
  adapter = new NodeFs(root, "core", history);
if (cut === "file-replaced") {
  const write = adapter.writeFile.bind(adapter);
  adapter.writeFile = async (file, raw) => {
    await write(file, raw);
    if (file === "N000/N000.md") await checkpoint(cut);
  };
}
const items = await Promise.all(
  Array.from({ length: 112 }, async (_, i) => {
    const nodeId = `node-n${String(i).padStart(3, "0")}`;
    return {
      op: "update" as const,
      nodeId,
      baseEtag: (await readNodeForEdit(adapter, nodeId)).etag,
      body: `new ${i}\n`,
    };
  }),
);
try {
  await writeNodesBatch(
    { fs: adapter, clock: { now: () => "2026-10-27T00:00:00.000Z" }, tentName: "Safety" },
    { items },
  );
  throw Error(`Missing safety checkpoint ${cut}`);
} finally {
  await adapter.close();
}
