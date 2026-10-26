import { runToolHook } from "./tool-hook.js";

const host = process.argv.at(-1);
let input = "";
for await (const chunk of process.stdin) input += chunk.toString();
try {
  const event = JSON.parse(input);
  process.stdout.write(
    host === "codex" || host === "claude-code" ? await runToolHook(host, event) : "{}\n",
  );
} catch {
  process.stdout.write("{}\n");
}
