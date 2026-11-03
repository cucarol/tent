import { parseArgs } from "node:util";
import { runTurnHook } from "./turn-hook.js";
import { cliErrorText, unknownCommandError } from "./error-text.js";
export const hookHelp =
  "tent hook stop --host codex|claude-code\nNative hook input is one JSON object on stdin.\n";
export async function runHookCommand(
  sub: string,
  args: string[],
  options: { packageRoot: string; stdin?: string },
) {
  const silent = { exitCode: 0, stdout: "{}\n", stderr: "" };
  try {
    if (["help", "--help", "-h"].includes(sub)) return { ...silent, stdout: hookHelp };
    if (sub !== "stop") throw unknownCommandError("tent hook", sub, ["stop"]);
    const { values } = parseArgs({
      args,
      options: {
        host: { type: "string" },
        workspace: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help) return { ...silent, stdout: hookHelp };
    if (values.host !== "codex" && values.host !== "claude-code")
      throw new Error("Hook host must be codex or claude-code");
    let raw = options.stdin;
    if (raw === undefined) {
      raw = "";
      if (!process.stdin.isTTY) for await (const chunk of process.stdin) raw += chunk.toString();
    }
    const input = JSON.parse(raw || "{}");
    return {
      ...silent,
      stdout: await runTurnHook(
        values.host,
        {
          eventName: input.hook_event_name,
          cwd: values.workspace ?? input.cwd,
          stopHookActive: input.stop_hook_active,
        },
        (reason) => JSON.stringify({ decision: "block", reason }) + "\n",
      ),
    };
  } catch (error) {
    return { ...silent, exitCode: 1, stderr: cliErrorText(error, "tent hook") + "\n" };
  }
}
