import type { SessionObservationActivity } from "../core/session-observations.js";

export type HookAdapter = {
  turnId(event: Record<string, unknown>): string | undefined;
  readActivity(
    transcriptPath: unknown,
    workspaceRoot: string,
    turnId: string,
    sessionCwd: string,
  ): Promise<SessionObservationActivity>;
  stopEnvelope(message: string): object;
};

/** The host owns both its wrapper and JSON escaping; Core budgets plain UTF-8 text. */
export function stopReviewOutput(
  adapter: HookAdapter,
  render: (textByteLimit: number) => string | undefined,
): string | undefined {
  const serialize = (message: string) => JSON.stringify(adapter.stopEnvelope(message)) + "\n";
  let budget = 2048 - Buffer.byteLength(serialize(""));
  while (budget > 0) {
    const message = render(budget);
    if (message === undefined) return undefined;
    const output = serialize(message);
    if (Buffer.byteLength(output) <= 2048) return output;
    // Request the next reduction, then measure again: removed text takes its escaping with it.
    budget = Buffer.byteLength(message) - 1;
  }
  return undefined;
}
