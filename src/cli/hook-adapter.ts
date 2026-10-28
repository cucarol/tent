import { formatWriteReview, type TurnReviewModule } from "../core/return/tool-turn-review.js";

export function toolReviewOutput(
  modules: TurnReviewModule[],
  files: string[] = [],
): { stdout: string; nodeIds: string[]; files: string[] } | undefined {
  const serialize = (message: string) =>
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: message },
    }) + "\n";
  let budget = 2048 - Buffer.byteLength(serialize(""));
  while (budget > 0) {
    const review = formatWriteReview(budget, modules, files);
    if (!review) return;
    const stdout = serialize(review.message);
    if (Buffer.byteLength(stdout) <= 2048)
      return { stdout, nodeIds: review.nodeIds, files: review.files };
    budget = Buffer.byteLength(review.message) - 1;
  }
}
