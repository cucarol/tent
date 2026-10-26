import { fileURLToPath } from "node:url";
const action = process.argv[1];
if (process.argv.length !== 2 || !["start", "tool"].includes(action))
  throw new Error("Invalid Tent hook action.");
if (action === "tool") {
  const runtime = new URL("../tool-hook.mjs", import.meta.url);
  process.argv = [process.execPath, fileURLToPath(runtime), "--host", "claude-code"];
  await import(runtime.href);
} else {
  const cli = new URL("../cli.mjs", import.meta.url);
  process.argv = [process.execPath, fileURLToPath(cli), "hook", action, "--host", "claude-code"];
  await import(cli.href);
}
