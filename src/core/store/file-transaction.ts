import * as z from "zod/v4";
import type { FsAdapter } from "./adapter.js";

export const TRANSACTION_PATH = ".git/tent-transaction.json";
export const TRANSACTION_CONFLICTS_PATH = ".git/tent-transaction-conflicts.json";
const relativePath = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !/[\\:\0]/.test(p) &&
      !p.startsWith("/") &&
      p.split("/").every((s) => s !== ".." && s !== "." && s !== "") &&
      ![".git", "mutation.lock"].includes(p.split("/")[0]!.toLowerCase()) &&
      !p.toLowerCase().startsWith("mutation.lock.guard"),
  );
// Bytes are base64, so a binary attachment moved with a Node is restored exactly.
const state = z.union([
  z.null(),
  z.literal("directory"),
  z.strictObject({
    bytes: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  }),
]);
export type TransactionFileState = z.infer<typeof state>;
export type ObservedTransactionState = TransactionFileState | "external";
const entry = z.strictObject({
  path: relativePath,
  before: state,
  after: state,
  versions: z.array(state),
});
const journal = z.strictObject({
  version: z.literal(1),
  publish: z
    .string()
    .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
    .nullable(),
  entries: z.array(entry),
});
type Journal = z.infer<typeof journal>;
const equal = (a: ObservedTransactionState, b: ObservedTransactionState) =>
  a === b ||
  (typeof a === "object" &&
    a !== null &&
    typeof b === "object" &&
    b !== null &&
    a.bytes === b.bytes);

/** Core write-ahead policy. Its adapter bypasses transaction/history tracking; caller owns mutation.lock. */
export class FileTransaction {
  private plan: Journal = { version: 1, publish: null, entries: [] };
  constructor(
    private readonly fs: FsAdapter,
    private readonly observe: (path: string) => Promise<ObservedTransactionState>,
    private readonly published: (commit: string) => Promise<boolean>,
  ) {}

  /** Persist the full affected set before the physical operation begins. */
  async prepare(
    changes: readonly {
      path: string;
      after: TransactionFileState;
      expected?: TransactionFileState;
    }[],
  ) {
    if (this.plan.publish !== null)
      throw new Error(
        "Tent publication was interrupted; settle the transaction before another write",
      );
    let changed = false;
    for (const change of changes) {
      relativePath.parse(change.path);
      const current = await this.observe(change.path);
      if (current === "external")
        throw new Error(
          `Tent transaction cannot replace an external filesystem entry: ${change.path}`,
        );
      if (change.expected !== undefined && !equal(current, change.expected))
        throw new Error(`File changed during transaction preparation: ${change.path}`);
      let item = this.plan.entries.find((item) => item.path === change.path);
      if (!item) {
        if (equal(current, change.after)) continue;
        item = { path: change.path, before: current, after: current, versions: [current] };
        this.plan.entries.push(item);
        changed = true;
      } else if (!item.versions.some((v) => equal(v, current))) {
        throw new Error(`File changed during transaction: ${change.path}`);
      }
      if (!equal(item.after, change.after)) changed = true;
      item.after = change.after;
      if (!item.versions.some((v) => equal(v, change.after))) item.versions.push(change.after);
    }
    if (changed) await this.save();
  }

  /** The exact candidate is durable before Git's own ref CAS. Never infer publication from file bytes. */
  async beforePublish(commit: string) {
    if (!this.plan.entries.length) return;
    this.plan.publish = commit;
    await this.save();
  }

  /** Successful command/capture: all files and the published ref have already been synchronized. */
  async finish() {
    if (!this.plan.entries.length) return;
    await this.fs.remove(TRANSACTION_PATH);
    this.plan = { version: 1, publish: null, entries: [] };
  }

  private save() {
    return this.fs.writeFile(TRANSACTION_PATH, JSON.stringify(this.plan) + "\n");
  }

  /** Idempotent restart recovery. Keep the record until every owned path has been settled. */
  async recover(): Promise<string[]> {
    if (!(await this.fs.exists(TRANSACTION_PATH))) return readTransactionConflicts(this.fs);
    const plan = journal.parse(JSON.parse(await this.fs.readFile(TRANSACTION_PATH)));
    if (new Set(plan.entries.map((e) => e.path)).size !== plan.entries.length)
      throw new Error("Invalid Tent transaction: duplicate paths");
    const forward = plan.publish !== null && (await this.published(plan.publish));
    const desired = (item: Journal["entries"][number]) => (forward ? item.after : item.before);
    const conflicts = new Set<string>();
    const matches = async (item: Journal["entries"][number]) => {
      const current = await this.observe(item.path);
      if (equal(current, desired(item))) return "done";
      if (item.versions.some((v) => equal(v, current))) return "owned";
      conflicts.add(item.path);
      return "conflict";
    };
    // Recreate parents before files; remove only empty directories after files.
    const entries = [...plan.entries].sort(
      (a, b) => a.path.split("/").length - b.path.split("/").length,
    );
    for (const item of entries) {
      if (desired(item) !== "directory" || (await matches(item)) !== "owned") continue;
      const current = await this.observe(item.path);
      if (current !== null && current !== "directory") await this.fs.remove(item.path);
      await this.fs.mkdir(item.path);
    }
    for (const item of entries) {
      const target = desired(item);
      if (target === "directory" || (await matches(item)) !== "owned") continue;
      const current = await this.observe(item.path);
      if (target === null && current === "directory") continue;
      if (current === "directory") {
        try {
          await this.fs.removeEmptyDir(item.path);
        } catch (error) {
          if (["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) {
            conflicts.add(item.path);
            continue;
          }
          throw error;
        }
      }
      if (target === null) {
        if (current !== null && current !== "directory") await this.fs.remove(item.path);
      } else await this.fs.writeBinary(item.path, Buffer.from(target.bytes, "base64"));
    }
    for (const item of entries.reverse()) {
      if (desired(item) !== null || (await this.observe(item.path)) !== "directory") continue;
      if (!item.versions.includes("directory")) {
        conflicts.add(item.path);
        continue;
      }
      try {
        await this.fs.removeEmptyDir(item.path);
      } catch (error) {
        if (["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? ""))
          conflicts.add(item.path);
        else if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    // Persist conflicts independently before retiring the journal, including on interrupted recovery.
    const previous = await readTransactionConflicts(this.fs);
    const all = [...new Set([...previous, ...conflicts])].sort();
    if (all.length) await this.fs.writeFile(TRANSACTION_CONFLICTS_PATH, JSON.stringify(all) + "\n");
    await this.fs.remove(TRANSACTION_PATH);
    this.plan = { version: 1, publish: null, entries: [] };
    return all;
  }
}

export async function readTransactionConflicts(fs: FsAdapter): Promise<string[]> {
  return (await fs.exists(TRANSACTION_CONFLICTS_PATH))
    ? z.array(relativePath).parse(JSON.parse(await fs.readFile(TRANSACTION_CONFLICTS_PATH)))
    : [];
}
