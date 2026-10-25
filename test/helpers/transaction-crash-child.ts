import fs from "node:fs/promises";
import native from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { NodeFs } from "../../src/fs/node-fs.js";
import { readNodeForEdit } from "../../src/core/read/node-query.js";
import { writeNodesBatch } from "../../src/core/write/node-write-batch.js";
import { runNodeCommand } from "../../src/cli/node-commands.js";
import { renameNode } from "../../src/core/graph/ops.js";
import { writeNodeDocument } from "../../src/core/graph/node-document-write.js";

const [workspace, cut, mode] = process.argv.slice(2) as [string, string, string];
const root = path.join(workspace, ".tent");
const adapter = new NodeFs(root);
const beforeB = await fs.readFile(path.join(root, "B/B.md"));
const pending = new Set<string>();
function checkpoint(point: string) {
  if (point !== cut) return;
  for (const p of pending) {
    try {
      const stat = native.statSync(p);
      if (stat.isFile()) native.writeFileSync(p, Buffer.alloc(stat.size));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (mode === "undo-B" && point === "published")
    native.writeFileSync(path.join(root, "B/B.md"), beforeB);
  process.stdout.write(JSON.stringify({ point, zeroed: [...pending] }) + "\n");
  process.exit(77);
}
const open = fs.open,
  rename = fs.rename;
fs.open = async (...args: Parameters<typeof open>) => {
  const handle = await open(...args),
    file = path.resolve(String(args[0]));
  const write = handle.writeFile.bind(handle),
    sync = handle.sync.bind(handle);
  handle.writeFile = async (...values: Parameters<typeof write>) => {
    await write(...values);
    pending.add(file);
    if (file.includes("tent-transaction.json.tmp-")) checkpoint("journal-written");
    if (file.includes(`A${path.sep}A.md.tmp-`)) checkpoint("A-written");
  };
  handle.sync = async () => {
    await sync();
    pending.delete(file);
    if (file.includes("tent-transaction.json.tmp-")) checkpoint("journal-synced");
    if (file.includes(`A${path.sep}A.md.tmp-`)) checkpoint("A-synced");
  };
  return handle;
};
fs.rename = async (...args: Parameters<typeof rename>) => {
  const from = path.resolve(String(args[0])),
    to = path.resolve(String(args[1]));
  if (mode === "no-journal" && to === path.join(root, ".git/tent-transaction.json")) return;
  await rename(...args);
  if (pending.delete(from)) pending.add(to);
  else pending.delete(to);
  if (to === path.join(root, "A/A.md")) checkpoint("A-renamed");
  if (to === path.join(root, "B/B.md")) checkpoint("B-renamed");
  if (from === path.join(root, "B") && to === path.join(root, "Moved"))
    checkpoint("directory-moved");
  if (to === path.join(root, ".git/tent-transaction.json")) {
    if (JSON.parse(native.readFileSync(to, "utf8")).publish) checkpoint("before-publish");
    else checkpoint("journal-renamed");
  }
};
const spawn = childProcess.spawn;
childProcess.spawn = ((...args: Parameters<typeof spawn>) => {
  const child = spawn(...args);
  const argv = args[1] as string[];
  if (argv.includes("update-ref") && argv.includes("--stdin"))
    child.stdout?.on("data", (bytes: Buffer) => {
      if (bytes.toString("utf8").includes("commit: ok")) checkpoint("published");
    });
  child.once("close", (code) => {
    if (code === 0 && argv.includes("update-ref") && !argv.includes("--stdin"))
      checkpoint("published");
  });
  return child;
}) as typeof spawn;
syncBuiltinESMExports();

if (mode === "recover") {
  const result = await runNodeCommand("get", [
    "node-a",
    "--full",
    "--json",
    "--workspace",
    workspace,
  ]);
  if (result.exitCode) throw new Error(result.stderr);
} else {
  const a = await readNodeForEdit(adapter, "node-a"),
    b = await readNodeForEdit(adapter, "node-b");
  const env = { fs: adapter, clock: { now: () => "2026-10-25T00:00:00.000Z" }, tentName: "Crash" };
  if (mode === "move") await renameNode(env, "node-b", "Moved");
  else if (mode === "single")
    await writeNodeDocument(adapter, "node-a", { baseEtag: a.etag, body: "NEW A\n" });
  else
    await writeNodesBatch(env, {
      items:
        mode === "create"
          ? [
              { op: "update", nodeId: "node-a", baseEtag: a.etag, body: "NEW A\n" },
              { op: "create", ref: "parent", name: "New", type: "goal" },
              {
                op: "create",
                ref: "child",
                parent: "@parent",
                name: "Child",
                type: "prompt",
                body: "CHILD\n",
              },
            ]
          : [
              { op: "update", nodeId: "node-a", baseEtag: a.etag, body: "NEW A\n" },
              { op: "update", nodeId: "node-b", baseEtag: b.etag, body: "NEW B\n" },
            ],
    });
}
checkpoint("returned");
throw new Error(`Unreached crash checkpoint: ${cut}`);
