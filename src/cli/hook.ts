import { captureNativeNodeEdits } from "../core/node-native-capture.js";
import path from "node:path";
import { parseArgs } from "node:util";
import { NodeFs } from "../fs/node-fs.js";
import { findTentSystemRoot } from "../core/status.js";
import { workspaceRootFromSystemRoot } from "../core/paths.js";
import { stopAdvice } from "../core/stop-advice.js";
import {
  saveSessionHistoryBaseline,
  type SessionObservationEvent,
} from "../core/session-observations.js";
import { loadStopMaterialIndex } from "../fs/stop-material-index.js";
import { claimStopReview, hasStopReviewClaim } from "../fs/stop-review-claim.js";
import { readCodexTurnActivity } from "./codex-turn-activity.js";
import { readClaudeTurnActivity } from "./claude-turn-activity.js";
import { stopReviewEnvelope } from "../core/stop-turn-review.js";
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
    const fs = new NodeFs(systemRoot);
    if (sub === "start") {
      await captureNativeNodeEdits(fs);
      if (typeof event.session_id === "string")
        await saveSessionHistoryBaseline(fs, event.session_id);
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
    const turnId = host === "codex" ? event.turn_id : event.prompt_id;
    // Older Claude versions without native prompt identity cannot safely select a turn.
    if (host === "claude-code" && typeof turnId !== "string") return silent;
    if (typeof event.session_id !== "string" || typeof turnId !== "string")
      throw new Error("Stop session and turn identities are required for observations");
    if (await hasStopReviewClaim(systemRoot, host, event.session_id, turnId)) return silent;
    const activity =
      host === "codex"
        ? await readCodexTurnActivity(event.transcript_path, workspaceRoot, turnId)
        : await readClaudeTurnActivity(event.transcript_path, workspaceRoot, turnId);
    if (activity.cancelled || !activity.observations.some((file) => file.kind === "written"))
      return silent;
    const observedAt = new Date().toISOString();
    const observed: SessionObservationEvent = {
      schema: 1,
      type: "turn",
      sessionId: event.session_id,
      turnId,
      observedAt,
      files: activity.observations.map((file) => ({
        ...file,
        version: { state: "uncertain", observedAt, phase: "stop" },
      })),
      signals: activity.signals,
      uncertain: activity.uncertain,
      ...(activity.nodeOrCardChanged ? { nodeOrCardChanged: true } : {}),
    };
    const message = stopAdvice(
      await loadStopMaterialIndex(systemRoot, workspaceRoot),
      observed,
      host,
    );
    if (!message || !(await claimStopReview(systemRoot, host, event.session_id, turnId)))
      return silent;
    return message
      ? { ...silent, stdout: JSON.stringify(stopReviewEnvelope(host, message)) + "\n" }
      : silent;
  } catch (error) {
    if (stopHookActive) return silent;
    const message = `Tent hook observation unavailable: ${error instanceof Error ? error.message : String(error)}`;
    // Errors are advisory and bounded too; they never ask Codex to run another turn.
    const display = Array.from(message).slice(0, 300).join("");
    return { ...silent, stdout: JSON.stringify({ systemMessage: display }) + "\n" };
  }
}
