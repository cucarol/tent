import fs from "node:fs/promises";
import path from "node:path";
import { NodeFs } from "../../src/fs/node-fs.js";
import { SqliteDocumentHistory } from "../../src/fs/sqlite-history.js";
import { saveNodesBatch } from "../node-edit.js";

const [workspace, cut] = process.argv.slice(2) as [string, string];
async function checkpoint(point: string) {
  if (point !== cut) return;
  process.send?.({ point, pid: process.pid });
  await new Promise<void>(() => setInterval(() => {}, 1000));
}
const root = path.join(workspace, ".tent"),
  history = new SqliteDocumentHistory(root, checkpoint),
  adapter = new NodeFs(root, history);
if (cut === "file-replaced") {
  const write = adapter.writeFile.bind(adapter);
  adapter.writeFile = async (file, raw) => {
    await write(file, raw);
    if (file === "M000/M000.md") await checkpoint(cut);
  };
}
const items = Array.from({ length: 112 }, (_, i) => ({
  op: "create" as const,
  ref: `m${i}`,
  id: `node-m${String(i).padStart(3, "0")}`,
  name: `M${String(i).padStart(3, "0")}`,
  type: "prompt",
  body: `new ${i}\n`,
}));
try {
  await saveNodesBatch(
    { fs: adapter, clock: { now: () => "2026-10-27T00:00:00.000Z" }, tentName: "Safety" },
    { items },
  );
  throw Error(`Missing safety checkpoint ${cut}`);
} finally {
  await adapter.close();
}
