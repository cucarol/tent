import * as z from "zod/v4";
import { createHash } from "node:crypto";
import type { FsAdapter } from "./adapter.js";
import { canonicalSha256 } from "./canonical-digest.js";
import {
  isOperationalPath,
  nodeNotePath,
  roleDocumentPath,
  ORDER_PATH,
  DELETE_PENDING_PATH,
} from "./paths.js";
import { isRoleId } from "./id.js";
import { parseRoleDocument } from "./role-document.js";
import { parseFrontmatter } from "./frontmatter.js";
import { loadTent } from "./tree.js";
import { isHistoryDocument } from "./document-history.js";

export { DELETE_PENDING_PATH };
const quarantine = "temp/delete-pending";
const relative = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !/[\\:\0]/.test(value) &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  );
const writeSchema = z.strictObject({
  path: relative,
  before: z.string().nullable(),
  after: z.string().nullable(),
});
const planSchema = z.strictObject({
  kind: z.enum(["node", "role"]),
  id: z.string(),
  source: relative,
  raw: z.string(),
  digest: z.string(),
  committed: z.boolean(),
  writes: z.array(writeSchema),
  nodeIds: z.array(z.string().regex(/^node-[A-Za-z0-9-]+$/)).default([]),
});
type Plan = z.infer<typeof planSchema>;
export type DeleteWrite = z.infer<typeof writeSchema>;
const conflict = (path: string) =>
  new Error(`Pending deletion conflict: ${path}; original objects and recovery record retained`);
const optional = async (fs: FsAdapter, path: string) =>
  (await fs.exists(path)) ? fs.readFile(path) : null;

async function primaryDigest(fs: FsAdapter, source: string, directory: boolean): Promise<string> {
  if (!directory) return canonicalSha256(await fs.readFile(source));
  const entries: { path: string; hash: string }[] = [];
  const walk = async (dir: string) => {
    for (const entry of await fs.listDir(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDir) {
        entries.push({ path: path.slice(source.length), hash: "directory" });
        await walk(path);
      } else
        entries.push({
          path: path.slice(source.length),
          hash: createHash("sha256")
            .update(await fs.readBinary(path))
            .digest("hex"),
        });
    }
  };
  await walk(source);
  return canonicalSha256(entries.sort((a, b) => a.path.localeCompare(b.path)));
}

function validate(value: unknown): Plan {
  const plan = planSchema.parse(value);
  if (parseFrontmatter(plan.raw).data.id !== plan.id) throw conflict("identity");
  if (plan.kind === "node") {
    if (!/^node-[A-Za-z0-9-]+$/.test(plan.id) || isOperationalPath(plan.source))
      throw conflict("source");
  } else {
    if (!isRoleId(plan.id) || plan.source !== roleDocumentPath(plan.id) || plan.nodeIds.length)
      throw conflict("source");
    parseRoleDocument(plan.id, plan.raw);
  }
  const paths = new Set<string>();
  for (const write of plan.writes) {
    const allowed = plan.kind === "node" && write.path === ORDER_PATH && write.after !== null;
    if (!allowed || paths.has(write.path)) throw conflict("associated write");
    paths.add(write.path);
  }
  return plan;
}

/** 隔离主对象是逻辑删除点；之后只按已校验的旧内容收尾，冲突保留记录。 */
export async function recoverPendingDeleteUnlocked(fs: FsAdapter) {
  if (!(await fs.exists(DELETE_PENDING_PATH))) return undefined;
  const plan = validate(JSON.parse(await fs.readFile(DELETE_PENDING_PATH)));
  const present = await fs.exists(plan.source),
    isolated = await fs.exists(quarantine);
  if (present && (plan.committed || isolated)) throw conflict(plan.source);
  if (plan.kind === "node" && (plan.committed || isolated)) {
    const live = await loadTent(fs);
    if ([...live.byPath.values()].some((node) => plan.nodeIds.includes(node.id)))
      throw conflict("reused Node identity");
  }
  if (!plan.committed && !present && !isolated) throw conflict("missing primary object");
  if (!plan.committed) {
    const location = present ? plan.source : quarantine;
    if ((await primaryDigest(fs, location, plan.kind === "node")) !== plan.digest)
      throw conflict(location);
  }
  for (const write of plan.writes) {
    const current = await optional(fs, write.path);
    if (current !== write.before && current !== write.after) throw conflict(write.path);
  }
  if (!plan.committed) {
    if (present) await fs.move(plan.source, quarantine);
    plan.committed = true;
    await fs.writeFile(DELETE_PENDING_PATH, JSON.stringify(plan) + "\n");
  }
  for (const write of plan.writes) {
    const current = await optional(fs, write.path);
    if (current === write.after) continue;
    if (current !== write.before) throw conflict(write.path);
    if (write.after === null) await fs.remove(write.path);
    else await fs.writeFile(write.path, write.after);
  }
  // Complete history while the durable delete record still exists, including a retry
  // whose original filesystem move happened in a previous process.
  if (fs.history && (await fs.exists(".git"))) {
    const paths =
      plan.kind === "role"
        ? [plan.source]
        : (await fs.history.pathsUnder(plan.source)).filter(isHistoryDocument);
    if (paths.length)
      await fs.history.captureUnlocked(
        paths.map((path) => ({ path, raw: null })),
        { operation: `${plan.kind}.delete` },
      );
  }
  if (await fs.exists(quarantine)) await fs.remove(quarantine);
  await fs.remove(DELETE_PENDING_PATH);
  return plan;
}

export async function executeDeleteUnlocked(
  fs: FsAdapter,
  input: Pick<Plan, "kind" | "id" | "source" | "raw" | "writes"> & { nodeIds?: string[] },
) {
  if ((await fs.exists(DELETE_PENDING_PATH)) || (await fs.exists(quarantine)))
    throw conflict("unfinished operation");
  const identity = input.kind === "node" ? nodeNotePath(input.source) : input.source;
  if ((await fs.readFile(identity)) !== input.raw) throw conflict(identity);
  const plan = validate({
    ...input,
    committed: false,
    digest: await primaryDigest(fs, input.source, input.kind === "node"),
  });
  await fs.mkdir("temp");
  await fs.writeFile(DELETE_PENDING_PATH, JSON.stringify(plan) + "\n");
  return (await recoverPendingDeleteUnlocked(fs))!;
}
