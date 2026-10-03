import path from "node:path";
import { parseArgs } from "node:util";
import { NodeFs } from "../fs/node-fs.js";
import { findTentSystemRoot } from "../core/status.js";
import { workspaceRootFromSystemRoot } from "../core/paths.js";
import { stopAdvice } from "../core/stop-advice.js";
import { observeMaterialResource } from "../fs/source-observation.js";
import { readCodexTurnActivity } from "./codex-turn-activity.js";
import { readBuildIdentity, formatBuildIdentity, sourceBuildMismatch } from "./build-identity.js";

export const hookHelp =
  "tent hook start|stop --host codex\nNative hook input is one JSON object on stdin. No Session registration or prompt baseline.\n";

export async function runHookCommand(
  sub: string,
  args: string[],
  options: { packageRoot: string; stdin?: string },
) {
  const silent = { exitCode: 0, stdout: "{}\n", stderr: "" };
  if (["help", "--help", "-h"].includes(sub)) return { ...silent, stdout: hookHelp };
  try {
    if (!["start", "stop"].includes(sub)) throw new Error(hookHelp);
    const { values } = parseArgs({ args, options: { host: { type: "string" } } });
    if (values.host !== "codex") throw new Error("Hook host must be codex");
    let text = options.stdin;
    if (text === undefined) {
      text = "";
      if (!process.stdin.isTTY) for await (const chunk of process.stdin) text += chunk.toString();
    }
    const input: unknown = JSON.parse(text || "{}");
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Expected native hook JSON object");
    const event = input as Record<string, unknown>;
    if (
      event.hook_event_name !== (sub === "start" ? "SessionStart" : "Stop") ||
      typeof event.cwd !== "string"
    )
      throw new Error("Native hook event/cwd is missing or mismatched");
    const systemRoot = await findTentSystemRoot(event.cwd);
    if (!systemRoot) return silent;
    const workspaceRoot = workspaceRootFromSystemRoot(systemRoot);
    if (!workspaceRoot) throw new Error("Tent requires an in-workspace .tent layout");
    if (sub === "start") {
      const command = `node ${JSON.stringify(path.join(options.packageRoot, "cli.mjs"))}`;
      const identity = await readBuildIdentity(options.packageRoot);
      const mismatch = await sourceBuildMismatch(workspaceRoot, identity);
      return {
        ...silent,
        stdout:
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "SessionStart",
              additionalContext: `Tent is available in this Workspace.\nWorkspace: ${workspaceRoot}\nCLI: ${command}\nBuild: ${formatBuildIdentity(identity)}\n${mismatch ? `${mismatch}\n` : ""}`,
            },
          }) + "\n",
      };
    }
    const activity = await readCodexTurnActivity(
      event.transcript_path,
      workspaceRoot,
      event.turn_id,
    );
    const message = await stopAdvice(
      new NodeFs(systemRoot),
      workspaceRoot,
      activity,
      (resource, documentPath) => observeMaterialResource(workspaceRoot, documentPath, resource),
    );
    return message
      ? { ...silent, stdout: JSON.stringify({ systemMessage: message }) + "\n" }
      : silent;
  } catch (error) {
    const message = `Tent hook observation unavailable: ${error instanceof Error ? error.message : String(error)}`;
    // Errors are advisory and bounded too; they never ask Codex to run another turn.
    const display = Array.from(message).slice(0, 300).join("");
    return { ...silent, stdout: JSON.stringify({ systemMessage: display }) + "\n" };
  }
}
