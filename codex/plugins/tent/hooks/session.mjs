import { fileURLToPath } from "node:url";

const action = process.argv[1];
if (process.argv.length !== 2 || !["start", "stop"].includes(action)) {
  throw new Error("Tent plugin hook requires start or stop.");
}

// 使用包内 CLI，保留宿主 stdin 和 cwd；不归档普通聊天、不补造会话身份。
const cli = new URL("../cli.mjs", import.meta.url);
process.argv = [process.execPath, fileURLToPath(cli), "hook", action, "--host", "codex"];
await import(cli.href);
