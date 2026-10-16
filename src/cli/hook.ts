import { captureNativeNodeEdits } from "../core/graph/node-native-capture.js";
import path from "node:path";
import { parseArgs } from "node:util";
import { NodeFs } from "../fs/node-fs.js";
import { findTentSystemRoot } from "../core/workspace/status.js";
import { workspaceRootFromSystemRoot } from "../core/base/paths.js";
import { stopAdvice } from "../core/return/stop-advice.js";
import type { SessionObservationEvent } from "../core/return/session-observations.js";
import { loadStopMaterialIndex } from "../fs/stop-material-index.js";
import { claimStopReview, hasStopReviewClaim } from "../fs/stop-review-claim.js";
import { codexHookAdapter } from "./codex-turn-activity.js";
import { claudeHookAdapter } from "./claude-turn-activity.js";
import { stopReviewOutput } from "./hook-adapter.js";
import { readBuildIdentity, formatBuildIdentity, sourceBuildMismatch } from "./build-identity.js";

export const hookHelp =
  "tent hook start|stop --host codex|claude-code\nNative hook input is one JSON object on stdin. No Session registration or prompt baseline.\n";

export async function runHookCommand(
  sub: string,
  args: string[],
  options: { packageRoot: string; stdin?: string },
) {
  const silent = { exitCode: 0, stdout: "{}\n", stderr: "" };
  let stopHookActive = false;
  if (["help", "--help", "-h"].includes(sub)) return { ...silent, stdout: hookHelp };
  try {
    if (!["start", "stop"].includes(sub)) throw new Error(hookHelp);
    const { values } = parseArgs({
      args,
      options: { host: { type: "string" }, help: { type: "boolean", short: "h" } },
    });
    if (values.help) return { ...silent, stdout: hookHelp };
    if (values.host !== "codex" && values.host !== "claude-code")
      throw new Error("Hook host must be codex or claude-code");
    const host = values.host;
    const adapter = host === "codex" ? codexHookAdapter : claudeHookAdapter;
    let text = options.stdin;
    if (text === undefined) {
      text = "";
      if (!process.stdin.isTTY) for await (const chunk of process.stdin) text += chunk.toString();
    }
    const input: unknown = JSON.parse(text || "{}");
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Expected native hook JSON object");
    const event = input as Record<string, unknown>;
    stopHookActive = sub === "stop" && event.stop_hook_active === true;
    if (stopHookActive) return silent;
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
      await captureNativeNodeEdits(new NodeFs(systemRoot));
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
    const turnId = adapter.turnId(event);
    if (turnId === undefined) return silent;
    if (typeof event.session_id !== "string" || typeof turnId !== "string")
      throw new Error("Stop session and turn identities are required for observations");
    if (await hasStopReviewClaim(systemRoot, host, event.session_id, turnId)) return silent;
    const activity = await adapter.readActivity(
      event.transcript_path,
      workspaceRoot,
      turnId,
      event.cwd,
    );
    if (activity.cancelled || !activity.observations.some((file) => file.kind === "written"))
      return silent;
    const observed: SessionObservationEvent = {
      turnId,
      files: activity.observations,
      signals: activity.signals,
      uncertain: activity.uncertain,
      ...(activity.nodeOrCardChanged ? { nodeOrCardChanged: true } : {}),
    };
    const index = await loadStopMaterialIndex(systemRoot, workspaceRoot);
    const output = stopReviewOutput(adapter, (textByteLimit) =>
      stopAdvice(index, observed, textByteLimit),
    );
    if (!output || !(await claimStopReview(systemRoot, host, event.session_id, turnId)))
      return silent;
    return { ...silent, stdout: output };
  } catch (error) {
    if (stopHookActive) return silent;
    const message = `Tent hook observation unavailable: ${error instanceof Error ? error.message : String(error)}`;
    // Errors are advisory and bounded too; they never ask Codex to run another turn.
    const display = Array.from(message).slice(0, 300).join("");
    return { ...silent, stdout: JSON.stringify({ systemMessage: display }) + "\n" };
  }
}
