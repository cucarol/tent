import { NodeFs } from "../../src/fs/node-fs.js";
import { moveNode, renameNode } from "../../src/core/ops.js";
import { withTentMutation } from "../../src/core/adapter.js";
import { NODE_MOVE_PENDING_PATH } from "../../src/core/node-move-recovery.js";

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
  override async remove(path: string) {
    if (path === NODE_MOVE_PENDING_PATH && crashPoint === "before-clear") process.exit(77);
    await super.remove(path);
  }
}
const fs = new CrashFs(root);
const env = { fs, clock: { now: () => new Date().toISOString() }, tentName: "crash" };
if (operation === "move") await moveNode(env, nodeId, parentId, { mode: "inside" });
else if (operation === "rename") await renameNode(env, nodeId, "renamed");
else if (operation === "recover") await withTentMutation(fs, async () => undefined);
else throw new Error(`Unknown operation: ${operation}`);
throw new Error(`Crash point not reached: ${crashPoint}`);
