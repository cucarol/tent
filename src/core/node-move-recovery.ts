import { z } from "zod";
import type { FsAdapter } from "./adapter.js";
import { isNodeId } from "./id.js";
import { isOperationalPath, nodeNotePath, ORDER_PATH, NODE_MOVE_PENDING_PATH } from "./paths.js";
import { parseFrontmatter } from "./frontmatter.js";
export { NODE_MOVE_PENDING_PATH };

const relativePath = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !/[\\:\0]/.test(path) &&
      !path.startsWith("/") &&
      path.split("/").every((part) => part !== ".." && part !== "." && part !== ""),
  );
const nodePath = relativePath.refine((path) => !isOperationalPath(path));
const plannedWrite = z
  .object({
    originalPath: relativePath,
    writePath: relativePath,
    originalContent: z.string().nullable(),
    newContent: z.string(),
  })
  .strict();
const pendingMove = z
  .object({
    version: z.literal(1),
    nodeId: z.string().refine(isNodeId),
    oldPath: nodePath,
    newPath: nodePath,
    writes: z.array(plannedWrite),
  })
  .strict();
export type NodeMoveWrite = z.infer<typeof plannedWrite>;
type PendingMove = z.infer<typeof pendingMove>;

const conflict = (path: string) =>
  new Error(`Pending Node move conflict: ${path}. Files and recovery record retained.`);
const movedPath = (plan: PendingMove, path: string) =>
  path.startsWith(plan.oldPath + "/") ? plan.newPath + path.slice(plan.oldPath.length) : path;
const readOptional = async (fs: FsAdapter, path: string) =>
  (await fs.exists(path)) ? fs.readFile(path) : null;

function validatePlan(value: unknown): PendingMove {
  const plan = pendingMove.parse(value);
  if (plan.newPath.startsWith(plan.oldPath + "/") || plan.oldPath.startsWith(plan.newPath + "/"))
    throw conflict("invalid directory move");
  const originalPaths = new Set<string>();
  const writePaths = new Set<string>();
  for (const write of plan.writes) {
    const expected =
      write.originalPath === nodeNotePath(plan.oldPath)
        ? nodeNotePath(plan.newPath)
        : movedPath(plan, write.originalPath);
    if (
      write.writePath !== expected ||
      originalPaths.has(write.originalPath) ||
      writePaths.has(write.writePath) ||
      (write.originalPath !== ORDER_PATH &&
        ((isOperationalPath(write.originalPath) &&
          !/^roles\/[^/]+\.md$/.test(write.originalPath)) ||
          write.originalContent === null ||
          !write.originalPath.endsWith(".md")))
    )
      throw conflict("invalid write plan");
    originalPaths.add(write.originalPath);
    writePaths.add(write.writePath);
  }
  if (!originalPaths.has(nodeNotePath(plan.oldPath))) throw conflict("missing Node identity");
  const identity = plan.writes.find((write) => write.originalPath === nodeNotePath(plan.oldPath));
  if (
    !identity?.originalContent ||
    parseFrontmatter(identity.originalContent).data.id !== plan.nodeId ||
    parseFrontmatter(identity.newContent).data.id !== plan.nodeId
  )
    throw conflict("invalid Node identity");
  return plan;
}

// 调用者已持有 Workspace 写锁；预检冲突不写文件，恢复中再遇外部冲突则保留记录供重试。
export async function recoverPendingNodeMoveUnlocked(fs: FsAdapter): Promise<void> {
  if (!(await fs.exists(NODE_MOVE_PENDING_PATH))) return;
  const plan = validatePlan(JSON.parse(await fs.readFile(NODE_MOVE_PENDING_PATH)));
  const atOld = await fs.exists(plan.oldPath);
  if (plan.oldPath === plan.newPath ? !atOld : atOld === (await fs.exists(plan.newPath)))
    throw conflict("source/destination directory identity");
  const identityBeforeRename = movedPath(plan, nodeNotePath(plan.oldPath));
  const identityAfterRename = nodeNotePath(plan.newPath);
  let identityPath = nodeNotePath(plan.oldPath);
  if (!atOld) {
    const before = await fs.exists(identityBeforeRename);
    const after = await fs.exists(identityAfterRename);
    if (identityBeforeRename !== identityAfterRename && before && after)
      throw conflict("duplicate identity note");
    identityPath = after ? identityAfterRename : identityBeforeRename;
  }
  const writes = plan.writes.map((write) => ({
    ...write,
    currentPath: atOld
      ? write.originalPath
      : write.originalPath === nodeNotePath(plan.oldPath)
        ? identityPath
        : write.writePath,
  }));
  for (const write of writes) {
    const current = await readOptional(fs, write.currentPath);
    if (current !== write.originalContent && current !== write.newContent)
      throw conflict(write.currentPath);
  }
  for (const write of writes) {
    const current = await readOptional(fs, write.currentPath);
    if (current === write.originalContent) continue;
    if (current !== write.newContent) throw conflict(write.currentPath);
    if (write.originalContent === null) await fs.remove(write.currentPath);
    else await fs.writeFile(write.currentPath, write.originalContent);
  }
  if (!atOld) {
    if (identityPath !== identityBeforeRename) await fs.move(identityPath, identityBeforeRename);
    await fs.move(plan.newPath, plan.oldPath);
  }
  if (
    !(await fs.exists(plan.oldPath)) ||
    (plan.oldPath !== plan.newPath && (await fs.exists(plan.newPath)))
  )
    throw conflict("restored directory");
  for (const write of plan.writes) {
    if ((await readOptional(fs, write.originalPath)) !== write.originalContent)
      throw conflict(write.originalPath);
  }
  await fs.remove(NODE_MOVE_PENDING_PATH);
}

// NodeFs.writeFile 原子替换记录；记录落盘后才移动目录，成功后才移除记录。
export async function executeNodeMoveUnlocked(
  fs: FsAdapter,
  input: Omit<PendingMove, "version">,
): Promise<void> {
  const identity = nodeNotePath(input.oldPath);
  const writes = [...input.writes];
  if (!writes.some((write) => write.originalPath === identity)) {
    const content = await fs.readFile(identity);
    writes.push({
      originalPath: identity,
      writePath: nodeNotePath(input.newPath),
      originalContent: content,
      newContent: content,
    });
  }
  const plan = validatePlan({ ...input, version: 1, writes });
  if (await fs.exists(NODE_MOVE_PENDING_PATH)) throw conflict("unfinished operation");
  if (plan.oldPath !== plan.newPath && (await fs.exists(plan.newPath)))
    throw conflict(plan.newPath);
  const movedIdentity = movedPath(plan, identity);
  const nextIdentity = nodeNotePath(plan.newPath);
  // 重命名不能覆盖子树中恰好与新名称相同的普通文件。
  if (
    movedIdentity !== nextIdentity &&
    (await fs.exists(plan.oldPath + nextIdentity.slice(plan.newPath.length)))
  )
    throw conflict(nextIdentity);
  for (const write of writes) {
    if ((await readOptional(fs, write.originalPath)) !== write.originalContent)
      throw conflict(write.originalPath);
  }
  await fs.writeFile(NODE_MOVE_PENDING_PATH, JSON.stringify(plan) + "\n");
  try {
    if (plan.oldPath !== plan.newPath) await fs.move(plan.oldPath, plan.newPath);
    if (movedIdentity !== nextIdentity) await fs.move(movedIdentity, nextIdentity);
    for (const write of writes) {
      if ((await readOptional(fs, write.writePath)) !== write.originalContent)
        throw conflict(write.writePath);
      if (write.newContent !== write.originalContent)
        await fs.writeFile(write.writePath, write.newContent);
    }
    if (
      (plan.oldPath !== plan.newPath && (await fs.exists(plan.oldPath))) ||
      !(await fs.exists(plan.newPath))
    )
      throw conflict("moved directory");
    for (const write of writes) {
      if ((await readOptional(fs, write.writePath)) !== write.newContent)
        throw conflict(write.writePath);
    }
    await fs.remove(NODE_MOVE_PENDING_PATH);
  } catch (error) {
    await recoverPendingNodeMoveUnlocked(fs);
    throw error;
  }
}
