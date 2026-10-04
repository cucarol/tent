import path from "node:path";
import { parseArgs } from "node:util";
import { NodeFs } from "../fs/node-fs.js";
import { findTentSystemRoot } from "../core/status.js";
import { workspaceRootFromSystemRoot } from "../core/paths.js";
import { stopAdvice } from "../core/stop-advice.js";
import {
  appendSessionObservations,
  saveSessionHistoryBaseline,
} from "../core/session-observations.js";
import { observeSessionFile } from "../fs/session-observations.js";
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
      if (typeof event.session_id === "string")
        await saveSessionHistoryBaseline(new NodeFs(systemRoot), event.session_id);
      const command = `node ${JSON.stringify(path.join(options.packageRoot, "cli.mjs"))}`;
      const identity = await readBuildIdentity(options.packageRoot);
      const mismatch = await sourceBuildMismatch(workspaceRoot, identity);
      return {
        ...silent,
        stdout:
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "SessionStart",
              additionalContext: `Tent is available in this Workspace.\nWorkspace: ${workspaceRoot}\nCLI: ${command}\nCurrent context: ${command} workspace brief --workspace ${JSON.stringify(workspaceRoot)} --json (at most 4 KiB).\nBuild: ${formatBuildIdentity(identity)}\n${mismatch ? `${mismatch}\n` : ""}`,
            },
          }) + "\n",
      };
    }
    const activity = await readCodexTurnActivity(
      event.transcript_path,
      workspaceRoot,
      event.turn_id,
    );
    if (typeof event.session_id !== "string" || typeof event.turn_id !== "string")
      throw new Error("Stop session and turn identities are required for observations");
    const fs = new NodeFs(systemRoot);
    const saved = await appendSessionObservations(
      fs,
      event.session_id,
      event.turn_id,
      activity,
      (address) => observeSessionFile(workspaceRoot, address),
    );
    if (!saved.appended || saved.event.cancelled) return silent;
    const message = await stopAdvice(fs, workspaceRoot, saved.event);
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
