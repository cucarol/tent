const action = process.argv[1];
if (process.argv.length !== 2 || action !== "stop") throw new Error("Invalid Tent hook action.");
const { runTurnHook } = await import(new URL("../turn-hook.mjs", import.meta.url).href);
let raw = "";
for await (const chunk of process.stdin) raw += chunk.toString();
try {
  const input = JSON.parse(raw);
  process.stdout.write(
    await runTurnHook(
      "codex",
      { eventName: input.hook_event_name, cwd: input.cwd, stopHookActive: input.stop_hook_active },
      (reason) => JSON.stringify({ decision: "block", reason }) + "\n",
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.stdout.write("{}\n");
  process.exitCode = 1;
}
