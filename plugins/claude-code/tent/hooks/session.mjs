import { fileURLToPath } from "node:url";
const action = process.argv[1];
if (process.argv.length !== 2 || !["start", "tool", "prompt", "stop"].includes(action))
  throw new Error("Invalid Tent hook action.");
if (action === "prompt" || action === "stop") {
  const { runTurnHook } = await import(new URL("../turn-hook.mjs", import.meta.url).href);
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk.toString();
  try {
    const input = JSON.parse(raw);
    process.stdout.write(
      await runTurnHook(
        "claude-code",
        {
          eventName: input.hook_event_name,
          cwd: input.cwd,
          sessionId: input.session_id,
          turnId: input.prompt_id,
          prompt: input.prompt,
          stopHookActive: input.stop_hook_active,
        },
        (reason) => JSON.stringify({ decision: "block", reason }) + "\n",
      ),
    );
  } catch {
    process.stdout.write("{}\n");
  }
} else if (action === "tool") {
  const runtime = new URL("../tool-hook.mjs", import.meta.url);
  process.argv = [process.execPath, fileURLToPath(runtime), "--host", "claude-code"];
  await import(runtime.href);
} else {
  const cli = new URL("../cli.mjs", import.meta.url);
  process.argv = [process.execPath, fileURLToPath(cli), "hook", action, "--host", "claude-code"];
  await import(cli.href);
}
