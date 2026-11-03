import type { NodeFs } from "../fs/node-fs.js";

/** Rendering only; recovery and conflict classification belong to Core. */
export async function transactionResult<T extends { stdout: string; stderr: string }>(
  action: (opened: (fs: NodeFs) => Promise<void>) => Promise<T>,
): Promise<T> {
  let adapter: NodeFs | undefined;
  const adapters = new Set<NodeFs>();
  try {
    const result = await action(async (fs) => {
      adapter = fs;
      adapters.add(fs);
      await fs.ready();
    });
    const conflicts = adapter?.recoveryConflicts;
    if (!conflicts?.length) return result;
    let stdout = result.stdout;
    try {
      const value: unknown = JSON.parse(stdout);
      if (value && typeof value === "object" && !Array.isArray(value))
        stdout = JSON.stringify({ ...value, recoveryConflicts: conflicts }) + "\n";
    } catch {
      /* Plain text and queue arrays keep their established shape. */
    }
    return {
      ...result,
      stdout,
      stderr:
        result.stderr +
        `Transaction recovery kept external edits: ${conflicts.map((p) => `.tent/${p}`).join(", ")}\n`,
    };
  } finally {
    await Promise.all([...adapters].map((fs) => fs.close()));
  }
}
