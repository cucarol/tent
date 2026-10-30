import path from "node:path";
import { createTurnPathResolver, readGitCheckout } from "../core/workspace/git-checkout.js";
import { changedTurnFiles, startTurnObservation } from "../core/return/turn-changes.js";
import {
  formatToolTurnReview,
  modulesForIndexedTurn,
  nodesLinkingSections,
  sectionsForTurn,
} from "../core/return/tool-turn-review.js";
import { findPreparedHookWorkspace } from "../fs/hook-material-index.js";
import { claimStopReview, hasStopReviewClaim } from "../fs/stop-review-claim.js";
import {
  ownTurnContinuation,
  readTurnRecord,
  rememberTurnContinuation,
  saveTurnRecord,
} from "../fs/turn-review-state.js";
import { observeTurnDirty } from "../fs/turn-dirty-baseline.js";
import { changedSections, settleSections } from "../fs/section-fingerprints.js";

export type TurnHookInput = {
  eventName: unknown;
  cwd: unknown;
  sessionId: unknown;
  turnId: unknown;
  prompt?: unknown;
  stopHookActive?: unknown;
};

/** Host packages normalize their fields and serialize their own Stop envelope. */
export async function runTurnHook(
  host: string,
  input: TurnHookInput,
  serialize: (reason: string) => string,
): Promise<string> {
  const silent = "{}\n";
  const startedAt = Date.now();
  try {
    const { eventName, cwd, sessionId, turnId } = input;
    if (
      !["UserPromptSubmit", "Stop"].includes(String(eventName)) ||
      typeof cwd !== "string" ||
      typeof sessionId !== "string" ||
      !sessionId ||
      (eventName === "UserPromptSubmit" && (typeof turnId !== "string" || !turnId))
    )
      return silent;
    const prepared = await findPreparedHookWorkspace(cwd);
    if (!prepared) return silent;
    const { systemRoot, workspaceRoot, index } = prepared;
    const resolver = await createTurnPathResolver(workspaceRoot, cwd);
    const checkout = resolver.checkoutRoot;
    if (!checkout || !(await readGitCheckout(checkout))) return silent;
    if (eventName === "UserPromptSubmit") {
      if (typeof turnId !== "string" || !turnId) return silent;
      if (await readTurnRecord(systemRoot, host, sessionId, turnId)) return silent;
      const continuation = await ownTurnContinuation(systemRoot, host, sessionId, input.prompt);
      await saveTurnRecord(
        systemRoot,
        host,
        sessionId,
        turnId,
        continuation ?? {
          turnId,
          checkout,
          baseline: await startTurnObservation(checkout, startedAt),
        },
      );
      return silent;
    }
    const { previous: previousDirty, status } = await observeTurnDirty(
      systemRoot,
      checkout,
      host,
      sessionId,
    );
    const record =
      typeof turnId === "string" && turnId
        ? await readTurnRecord(systemRoot, host, sessionId, turnId)
        : undefined;
    if (input.stopHookActive === true || !record || path.relative(record.checkout, checkout) !== "")
      return silent;
    const stopKey = JSON.stringify([record.turnId, "turn-stop"]);
    if (await hasStopReviewClaim(systemRoot, host, sessionId, stopKey)) return silent;
    const files = await changedTurnFiles(checkout, record.baseline, previousDirty, status);
    const changed = await changedSections(systemRoot, checkout, sectionsForTurn(index, files));
    let candidates = modulesForIndexedTurn(index, {
      files: files.map((address) => ({ kind: "written" as const, address })),
      changedSections: new Set(changed.keys()),
    });
    const allModules = candidates;
    const key = (id: string) => JSON.stringify([record.turnId, "node", id]);
    const pending = await Promise.all(
      candidates.map(
        async (node) => !(await hasStopReviewClaim(systemRoot, host, sessionId, key(node.nodeId))),
      ),
    );
    candidates = candidates.filter((_, i) => pending[i]);
    const owned = new Set<string>();
    let reserved = false;
    for (;;) {
      let budget = 2048 - Buffer.byteLength(serialize(""));
      let output;
      while (budget > 0) {
        output = formatToolTurnReview(budget, candidates, "turn");
        if (!output || Buffer.byteLength(serialize(output.message)) <= 2048) break;
        budget = Buffer.byteLength(output.message) - 1;
      }
      if (!output || Buffer.byteLength(serialize(output.message)) > 2048) {
        if (!candidates.length) await settleSections(systemRoot, checkout, changed);
        return silent;
      }
      // Reserve the one continuation before taking any render-only Node claims.
      if (!reserved) {
        if (!(await claimStopReview(systemRoot, host, sessionId, stopKey))) return silent;
        reserved = true;
      }
      const competing = new Set<string>();
      for (const node of output.nodeIds) {
        if (owned.has(node)) continue;
        if (await claimStopReview(systemRoot, host, sessionId, key(node))) owned.add(node);
        else competing.add(node);
      }
      if (!competing.size) {
        const unnamed = new Set(
          allModules
            .filter(
              (node) =>
                !output.nodeIds.includes(node.nodeId) &&
                candidates.some((candidate) => candidate.nodeId === node.nodeId),
            )
            .map((node) => node.nodeId),
        );
        const settled = new Map(
          [...changed].filter(
            ([section]) =>
              ![...nodesLinkingSections(index, new Set([section]))].some((id) => unnamed.has(id)),
          ),
        );
        await settleSections(systemRoot, checkout, settled).catch(() => undefined);
        await rememberTurnContinuation(systemRoot, host, sessionId, record.turnId, output.message);
        return serialize(output.message);
      }
      candidates = candidates.filter((node) => !competing.has(node.nodeId));
    }
  } catch {
    return silent;
  }
}
