import { formatWriteReview, type TurnReviewModule } from "../core/return/tool-turn-review.js";
import {
  formatNodeWriteProblems,
  type NodeWriteProblem,
} from "../core/check/node-write-problems.js";

export const HOOK_REVIEW_BYTE_LIMIT = 8 * 1024;
export const serializeToolReview = (message: string) =>
  JSON.stringify({
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: message },
  }) + "\n";

export function toolReviewOutput(
  modules: TurnReviewModule[],
  files: string[] = [],
  problems: readonly NodeWriteProblem[] = [],
):
  | {
      stdout: string;
      nodeIds: string[];
      ownerNodeIds: string[];
      ruleNodeIds: string[];
      files: string[];
    }
  | undefined {
  const prefix = formatNodeWriteProblems(problems, HOOK_REVIEW_BYTE_LIMIT, (message) =>
    Buffer.byteLength(serializeToolReview(message)),
  );
  const serialize = (message: string) =>
    serializeToolReview([prefix, message].filter(Boolean).join("\n\n"));
  let budget = HOOK_REVIEW_BYTE_LIMIT - Buffer.byteLength(serialize(""));
  while (budget > 0) {
    const review = formatWriteReview(budget, modules, files);
    if (!review) break;
    const stdout = serialize(review.message);
    if (Buffer.byteLength(stdout) <= HOOK_REVIEW_BYTE_LIMIT)
      return {
        stdout,
        nodeIds: review.nodeIds,
        ownerNodeIds: review.ownerNodeIds,
        ruleNodeIds: review.ruleNodeIds,
        files: review.files,
      };
    budget = Buffer.byteLength(review.message) - 1;
  }
  if (prefix)
    return {
      stdout: serializeToolReview(prefix),
      nodeIds: [],
      ownerNodeIds: [],
      ruleNodeIds: [],
      files: [],
    };
}
