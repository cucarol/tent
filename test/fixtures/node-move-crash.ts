import { NodeFs } from "../../src/fs/node-fs.js";
import { moveNode, renameNode } from "../../src/core/graph/ops.js";

const [root, operation, nodeId, parentId, crashPoint] = process.argv.slice(2);
if (!root || !operation || !nodeId || !parentId || !crashPoint)
  throw new Error("Missing crash fixture arguments");
let moves = 0;
class CrashFs extends NodeFs {
  override async move(from: string, to: string) {
    await super.move(from, to);
    moves++;
    if (crashPoint === `move-${moves}`) process.exit(77);
  }
  override async writeFile(path: string, content: string) {
    await super.writeFile(path, content);
    if (path === crashPoint) process.exit(77);
  }
}
const fs = new CrashFs(root);
const env = { fs, clock: { now: () => new Date().toISOString() }, tentName: "crash" };
if (operation === "move") await moveNode(env, nodeId, parentId);
else if (operation === "rename") await renameNode(env, nodeId, "renamed");
else throw new Error(`Unknown operation: ${operation}`);
throw new Error(`Crash point not reached: ${crashPoint}`);
