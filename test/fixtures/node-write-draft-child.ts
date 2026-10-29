import fs from "node:fs/promises";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { NodeFs } from "../../src/fs/node-fs.js";
import { SqliteDocumentHistory } from "../../src/core/store/sqlite-history.js";

const [workspace, cut] = process.argv.slice(2) as [string, string];
const filename = path.join(workspace, "draft.json");
async function checkpoint(point: string) {
  if (cut !== point) return;
  process.send?.({ point, pid: process.pid });
  await new Promise<void>(() => setInterval(() => {}, 1000));
}
if (cut === "ids-checkpointed") {
  const rename = fs.rename;
  fs.rename = async (...args) => {
    await rename(...args);
    if (String(args[1]) === filename) await checkpoint(cut);
  };
  syncBuiltinESMExports();
}
if (cut === "node-written") {
  const write = NodeFs.prototype.writeFile;
  NodeFs.prototype.writeFile = async function (file, raw) {
    await write.call(this, file, raw);
    if (file === "Parent/Parent.md") await checkpoint(cut);
  };
}
if (cut === "captured") {
  const capture = SqliteDocumentHistory.prototype.captureUnlocked;
  SqliteDocumentHistory.prototype.captureUnlocked = async function (...args) {
    const result = await capture.apply(this, args);
    if (args[1]?.operation === "node.write-many") await checkpoint(cut);
    return result;
  };
}
const { runNodeCommand } = await import("../../src/cli/node-commands.js");
const result = await runNodeCommand("write-many", ["--draft", "draft.json", "--json"], {
  workspace,
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
