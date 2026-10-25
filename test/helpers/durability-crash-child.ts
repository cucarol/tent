import fs from "node:fs/promises";
import syncFs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { NodeFs } from "../../src/fs/node-fs.js";

const [root, target] = process.argv.slice(2) as [string, string];
const badOrder = process.argv[4] === "bad-order";
const pending = new Set<string>();
const resolve = (file: string) => path.resolve(file);
function checkpoint(point: string) {
  if (point !== target) return;
  for (const file of pending) {
    try {
      const stat = syncFs.statSync(file);
      if (stat.isFile()) syncFs.writeFileSync(file, Buffer.alloc(stat.size));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  process.stdout.write(JSON.stringify({ point, zeroed: [...pending] }) + "\n");
  process.exit(77); // Deliberately skip finally/lock cleanup, as a terminated writer would.
}
const isDocumentTemp = (file: string) => file.includes(`N${path.sep}N.md.tmp-`);
const open = fs.open,
  writeFile = fs.writeFile,
  rename = fs.rename;
fs.writeFile = async (...args: Parameters<typeof writeFile>) => {
  await writeFile(...args);
  if (typeof args[0] === "string") pending.add(resolve(args[0]));
};
fs.open = async (...args: Parameters<typeof open>) => {
  const handle = await open(...args),
    file = resolve(String(args[0]));
  const write = handle.writeFile.bind(handle),
    sync = handle.sync.bind(handle);
  handle.writeFile = async (...values: Parameters<typeof write>) => {
    await write(...values);
    pending.add(file);
    if (isDocumentTemp(file)) checkpoint("file-written");
  };
  handle.sync = async () => {
    if (badOrder && isDocumentTemp(file)) return;
    await sync();
    pending.delete(file);
    if (isDocumentTemp(file)) checkpoint("file-synced");
  };
  return handle;
};
fs.rename = async (...args: Parameters<typeof rename>) => {
  const from = resolve(String(args[0])),
    to = resolve(String(args[1]));
  if (isDocumentTemp(from)) checkpoint("before-rename");
  await rename(...args);
  if (pending.delete(from)) pending.add(to);
  else pending.delete(to);
  if (isDocumentTemp(from)) checkpoint("after-rename");
  if (from === path.join(root, ".git/logs")) checkpoint("after-reflog-migration");
};
const spawn = childProcess.spawn;
childProcess.spawn = ((...args: Parameters<typeof spawn>) => {
  const argv = args[1] as string[];
  if (argv.includes(`--git-dir=${path.join(root, ".git")}`)) {
    if (
      !argv.includes("core.fsync=all") ||
      !argv.includes("core.fsyncMethod=fsync") ||
      !argv.includes("core.logAllRefUpdates=false")
    )
      throw new Error("Fault model requires Git's configured file synchronization");
  }
  const child = spawn(...args);
  if (argv.includes("update-ref") && argv.includes("--stdin"))
    child.stdout?.on("data", (bytes: Buffer) => {
      if (bytes.toString("utf8").includes("commit: ok")) checkpoint("after-update-ref");
    });
  child.once("close", (code) => {
    if (code !== 0) return;
    if (argv.includes("update-ref")) {
      const head = syncFs.readFileSync(path.join(root, ".git/HEAD"), "utf8").trim();
      for (const log of [
        "logs/HEAD",
        ...(head.startsWith("ref: ") ? [`logs/${head.slice(5)}`] : []),
      ]) {
        const file = path.join(root, ".git", log);
        if (syncFs.existsSync(file)) pending.add(file);
      }
    }
    for (const command of ["hash-object", "write-tree", "commit-tree", "update-ref"])
      if (argv.includes(command) && !(command === "update-ref" && argv.includes("--stdin")))
        checkpoint(`after-${command}`);
    if (argv.includes("read-tree") && !(args[2] as { env?: NodeJS.ProcessEnv }).env?.GIT_INDEX_FILE)
      checkpoint("after-index-mirror");
  });
  return child;
}) as typeof spawn;
syncBuiltinESMExports();
const adapter = new NodeFs(root);
await adapter.withLock("mutation.lock", () =>
  adapter.withDocumentHistory(
    () => adapter.writeFile("N/N.md", "---\nid: node-n\ntype: prompt\n---\nnew complete bytes\n"),
    { operation: "node.write", objectIds: ["node-n"] },
  ),
);
checkpoint("after-return");
throw new Error(`Fault checkpoint was not reached: ${target}`);
