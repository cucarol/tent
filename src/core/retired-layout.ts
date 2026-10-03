import type { FsAdapter } from "./adapter.js";
import { nodeNotePath } from "./paths.js";

/** Diagnose recognizable retired storage before it can be mistaken for live Nodes. */
export async function assertCurrentLayout(fs: FsAdapter, directories: string[]): Promise<void> {
  const signatures: Record<string, RegExp> = {
    snapshots: /^objects$/,
    "retained-versions": /^version-.+\.json$/,
    "version-leases": /^version-.+\.json$/,
    "card-consumptions": /^card-.+\.json$/,
    returns: /^return-.+\.json$/,
    notes: /^note-.+\.md$/,
  };
  const found: string[] = [];
  for (const directory of directories) {
    const pattern = signatures[directory];
    if (!pattern || (await fs.exists(nodeNotePath(directory)))) continue;
    if ((await fs.listDir(directory)).some((entry) => pattern.test(entry.name)))
      found.push(directory);
  }
  if (found.length) {
    throw new Error(
      `Retired Tent storage found: ${found.join(", ")}. Move these old stores outside .tent before reading the current graph; they were not indexed or changed.`,
    );
  }
}
