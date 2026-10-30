import { captureNativeNodeEdits } from "../core/graph/node-native-capture.js";
import path from "node:path";
import { parseArgs } from "node:util";
import { NodeFs } from "../fs/node-fs.js";
import { observeTentSystemRoot } from "../core/workspace/status.js";
import { workspaceRootFromSystemRoot } from "../core/base/paths.js";
import { loadStopMaterialIndex } from "../fs/stop-material-index.js";
import { recordSectionFingerprints } from "../fs/section-fingerprint-baseline.js";
import { readBuildIdentity, formatBuildIdentity, sourceBuildMismatch } from "./build-identity.js";
import { seedSessionTurnDirty } from "../fs/turn-dirty-baseline.js";

export const hookHelp =
  "tent hook start|stop --host codex|claude-code\nNative hook input is one JSON object on stdin. start prepares the session's coverage; stop does nothing. Turn-end reminders come from the plugin's own UserPromptSubmit and Stop hooks.\n";

export async function runHookCommand(
  sub: string,
  args: string[],
  options: { packageRoot: string; stdin?: string },
) {
  const silent = { exitCode: 0, stdout: "{}\n", stderr: "" };
  if (
    ["help", "--help", "-h"].includes(sub) ||
    (sub === "stop" && args.some((arg) => arg === "--help" || arg === "-h"))
  )
    return { ...silent, stdout: hookHelp };
  // Plugin Stop events use the separate turn runtime; this public no-op reads no input.
  if (sub === "stop") return silent;
  try {
    if (!["start"].includes(sub)) throw new Error(hookHelp);
    const { values } = parseArgs({
      args,
      options: { host: { type: "string" }, help: { type: "boolean", short: "h" } },
    });
    if (values.help) return { ...silent, stdout: hookHelp };
    if (values.host !== "codex" && values.host !== "claude-code")
      throw new Error("Hook host must be codex or claude-code");
    let text = options.stdin;
    if (text === undefined) {
      text = "";
      if (!process.stdin.isTTY) for await (const chunk of process.stdin) text += chunk.toString();
    }
    const input: unknown = JSON.parse(text || "{}");
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Expected native hook JSON object");
    const event = input as Record<string, unknown>;
    if (event.hook_event_name !== "SessionStart" || typeof event.cwd !== "string")
      throw new Error("Native hook event/cwd is missing or mismatched");
    const discovery = await observeTentSystemRoot(event.cwd);
    const systemRoot = discovery.systemRoot;
    if (!systemRoot) return silent;
    const workspaceRoot = workspaceRootFromSystemRoot(systemRoot);
    if (!workspaceRoot) throw new Error("Tent requires an in-workspace .tent layout");
    if (sub === "start") {
      const adapter = new NodeFs(systemRoot);
      try {
        await captureNativeNodeEdits(adapter);
      } finally {
        await adapter.close();
      }
      const index = await loadStopMaterialIndex(
        systemRoot,
        workspaceRoot,
        discovery.rejectedRootMarkers,
      );
      await recordSectionFingerprints(systemRoot, workspaceRoot, index);
      if (typeof event.session_id === "string" && event.session_id)
        await seedSessionTurnDirty(
          systemRoot,
          workspaceRoot,
          event.cwd,
          values.host,
          event.session_id,
        ).catch(() => undefined);
      const command = `node ${JSON.stringify(path.join(options.packageRoot, "cli.mjs"))}`;
      const identity = await readBuildIdentity(options.packageRoot);
      const mismatch = await sourceBuildMismatch(workspaceRoot, identity);
      return {
        ...silent,
        stdout:
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "SessionStart",
              additionalContext: `Tent Workspace: ${workspaceRoot}\nTent CLI: ${command}\nCurrent context: Tent CLI with workspace brief --json\nBuild: ${formatBuildIdentity(identity)}\n${mismatch ? `${mismatch}\n` : ""}`,
            },
          }) + "\n",
      };
    }
    return silent;
  } catch (error) {
    const message = `Tent hook observation unavailable: ${error instanceof Error ? error.message : String(error)}`;
    // Errors are advisory and bounded too; they never ask Codex to run another turn.
    const display = Array.from(message).slice(0, 300).join("");
    return { ...silent, stdout: JSON.stringify({ systemMessage: display }) + "\n" };
  }
}
