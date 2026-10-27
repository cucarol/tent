import { formatToolTurnReview, type TurnReviewModule } from "../core/return/tool-turn-review.js";

export function toolReviewOutput(
  modules: TurnReviewModule[],
): { stdout: string; nodeIds: string[] } | undefined {
  const serialize = (message: string) =>
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: message },
    }) + "\n";
  let budget = 2048 - Buffer.byteLength(serialize(""));
  while (budget > 0) {
    const review = formatToolTurnReview(budget, modules);
    if (!review) return;
    const stdout = serialize(review.message);
    if (Buffer.byteLength(stdout) <= 2048) return { stdout, nodeIds: review.nodeIds };
    budget = Buffer.byteLength(review.message) - 1;
  }
}
