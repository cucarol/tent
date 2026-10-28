import path from "node:path";
import { createTurnPathResolver } from "../core/workspace/git-checkout.js";
import { findPreparedHookWorkspace } from "../fs/hook-material-index.js";
import { claimStopReview, hasStopReviewClaim } from "../fs/stop-review-claim.js";
import { changedSections, settleSections } from "../fs/section-fingerprints.js";
import {
  ANSWER_REVIEW,
  modulesForIndexedTurn,
  nodesLinkingSections,
  sectionsForTurn,
} from "../core/return/tool-turn-review.js";
import { toolReviewOutput } from "./hook-adapter.js";
import { answeredQuestion, successfulWritePaths } from "./tool-write-event.js";

/** Deliberately separate from the CLI, transcript readers, Git and live catalog loader. */
export async function runToolHook(
  host: "codex" | "claude-code",
  event: Record<string, unknown>,
): Promise<string> {
  const silent = "{}\n";
  try {
    if (
      event.hook_event_name !== "PostToolUse" ||
      typeof event.cwd !== "string" ||
      typeof event.session_id !== "string" ||
      !event.session_id
    )
      return silent;
    const turnId = host === "codex" ? event.turn_id : event.prompt_id;
    if (typeof turnId !== "string" || !turnId) return silent;
    const files = successfulWritePaths(host, event);
    const answered = answeredQuestion(event);
    if (!files.length && !answered) return silent;
    const prepared = await findPreparedHookWorkspace(event.cwd);
    if (!prepared) return silent;
    const { systemRoot, workspaceRoot, index } = prepared;
    if (answered) {
      if (typeof event.tool_use_id !== "string" || !event.tool_use_id) return silent;
      if (
        !(await claimStopReview(
          systemRoot,
          host,
          event.session_id,
          JSON.stringify([turnId, "answer", event.tool_use_id]),
        ))
      )
        return silent;
      return (
        JSON.stringify({
          hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: ANSWER_REVIEW },
        }) + "\n"
      );
    }
    const resolver = await createTurnPathResolver(workspaceRoot, event.cwd);
    const addresses = await Promise.all(
      files
        .filter((file) => file && !/[\u0000-\u001f]/.test(file))
        .map((file) =>
          resolver.relative(
            path.resolve(
              host === "codex"
                ? (resolver.checkoutRoot ?? (event.cwd as string))
                : (event.cwd as string),
              file,
            ),
          ),
        ),
    );
    const written = addresses.flatMap((address) =>
      address &&
      !address
        .split("/")
        .some((part) =>
          [".tent", ".git", ".scratch", "node_modules", ".venv"].includes(
            process.platform === "win32" ? part.toLowerCase() : part,
          ),
        )
        ? [address]
        : [],
    );
    const changed = await changedSections(
      systemRoot,
      workspaceRoot,
      sectionsForTurn(index, written),
    );
    const modules = modulesForIndexedTurn(index, {
      files: written.map((address) => ({ kind: "written" as const, address })),
      changedSections: new Set(changed.keys()),
    });
    if (!modules.length) return silent;
    // A changed section stays unsettled while a Node linking it is left unnamed.
    const settle = async (unnamed: Set<string>) => {
      const named = new Map(
        [...changed].filter(
          ([section]) =>
            ![...nodesLinkingSections(index, new Set([section]))].some((nodeId) =>
              unnamed.has(nodeId),
            ),
        ),
      );
      await settleSections(systemRoot, workspaceRoot, named).catch(() => undefined);
    };
    const key = (nodeId: string) => JSON.stringify([turnId, "node", nodeId]);
    const pending = [];
    for (const module of modules)
      if (!(await hasStopReviewClaim(systemRoot, host, event.session_id, key(module.nodeId))))
        pending.push(module);
    if (!pending.length) {
      await settle(new Set());
      return silent;
    }
    let candidates = pending;
    const owned = new Set<string>();
    for (;;) {
      const output = toolReviewOutput(candidates);
      if (!output) return silent;
      const competing = new Set<string>();
      for (const nodeId of output.nodeIds) {
        if (owned.has(nodeId)) continue;
        if (await claimStopReview(systemRoot, host, event.session_id, key(nodeId)))
          owned.add(nodeId);
        else competing.add(nodeId);
      }
      // Keep the complete rendered projection, including Nodes omitted by either
      // byte budget or count. They were not claimed and may be named by a later tool.
      if (!competing.size) {
        await settle(
          new Set(
            candidates
              .filter((module) => !output.nodeIds.includes(module.nodeId))
              .map((module) => module.nodeId),
          ),
        );
        return output.stdout;
      }
      // Another hook owns these Nodes. Rebudget without them and claim any newly
      // visible Nodes before delivering; keep this process's existing claims.
      candidates = candidates.filter((module) => !competing.has(module.nodeId));
    }
  } catch {
    return silent;
  }
}
