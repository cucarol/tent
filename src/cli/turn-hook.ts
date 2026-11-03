import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { observeTentSystemRoot } from "../core/workspace/status.js";
import { workspaceRootFromSystemRoot, nodeNotePath } from "../core/base/paths.js";
import { createTurnPathResolver } from "../core/workspace/git-checkout.js";
import { observeStopChanges } from "../fs/stop-snapshot.js";
import { loadStopCoverage } from "../fs/stop-coverage.js";
import {
  selectStopCoverage,
  formatStopCoverage,
  stopCoverageSections,
} from "../core/return/stop-coverage.js";
import { changedSections, settleSections } from "../fs/section-fingerprints.js";
import { captureNativeNodeEdits } from "../core/graph/node-native-capture.js";
import { checkNodeWriteProblems } from "../fs/node-write-problems.js";
import { withFileLockGuard } from "../fs/file-lock-guard.js";
import { NodeFs } from "../fs/node-fs.js";
export type TurnHookInput = { eventName: unknown; cwd: unknown; stopHookActive?: unknown };
/** The host owns only its native envelope. Adjacent Stops observe one checkout. */
export async function runTurnHook(
  _host: string,
  input: TurnHookInput,
  serialize: (reason: string) => string,
): Promise<string> {
  if (input.eventName !== "Stop" || typeof input.cwd !== "string") return "{}\n";
  const { systemRoot } = await observeTentSystemRoot(input.cwd);
  if (!systemRoot) return "{}\n";
  const workspaceRoot = workspaceRootFromSystemRoot(systemRoot);
  if (!workspaceRoot) return "{}\n";
  const resolver = await createTurnPathResolver(workspaceRoot, input.cwd);
  if (!resolver.checkoutRoot || !resolver.checkoutWorkspaceRoot) return "{}\n";
  const checkout = await fs.realpath(resolver.checkoutRoot);
  const checkoutWorkspace = await fs.realpath(resolver.checkoutWorkspaceRoot);
  const prefix = resolver.workspacePrefix ? `${resolver.workspacePrefix}/` : "";
  const local = (file: string) => {
    const matches =
      process.platform === "win32"
        ? file.toLowerCase().startsWith(prefix.toLowerCase())
        : file.startsWith(prefix);
    return matches ? file.slice(prefix.length) : undefined;
  };
  const identity = createHash("sha256")
    .update(process.platform === "win32" ? checkout.toLowerCase() : checkout)
    .digest("hex");
  const sectionRoot = path.join(systemRoot, "temp", "stop-checkouts", identity);
  await fs.mkdir(path.dirname(sectionRoot), { recursive: true });
  return withFileLockGuard(
    sectionRoot,
    async () => {
      const adapter = new NodeFs(systemRoot);
      try {
        const [snapshotResult, coverageResult] = await Promise.allSettled([
          observeStopChanges(systemRoot, checkout),
          loadStopCoverage(systemRoot, workspaceRoot, adapter),
        ]);
        if (snapshotResult.status === "rejected") throw snapshotResult.reason;
        if (coverageResult.status === "rejected") throw coverageResult.reason;
        const snapshot = snapshotResult.value;
        const index = coverageResult.value;
        const changedFiles = snapshot.files.flatMap((file) => {
          const relative = local(file);
          return relative === undefined ? [] : [relative];
        });
        const sections = await changedSections(
          systemRoot,
          checkoutWorkspace,
          stopCoverageSections(index, changedFiles),
          (file) => snapshot.readPreviousFile(prefix + file),
        );
        const captured = await captureNativeNodeEdits(adapter);
        const invalid = new Set(
          captured.invalidNodes.map((node) => path.resolve(workspaceRoot, node.path)),
        );
        const pointers = selectStopCoverage(
          index,
          changedFiles,
          new Set(sections.changed.keys()),
        ).filter((node) => !invalid.has(node.path));
        const present = new Set(
          [...(captured.catalog?.tree.byPath.values() ?? [])].map((node) =>
            nodeNotePath(node.path),
          ),
        );
        const invalidNativePaths = new Set(captured.invalidNodes.map((node) => node.path.slice(6)));
        const checked = await checkNodeWriteProblems(
          adapter,
          workspaceRoot,
          captured.changedNodePaths.filter(
            (file) => present.has(file) && !invalidNativePaths.has(file),
          ),
        );
        const edited = new Set(captured.changedNodePaths.map((file) => `.tent/${file}`));
        const nodeProblems: Record<string, string> = Object.create(null);
        const invalidProblems = [];
        for (const node of captured.invalidNodes) {
          if (!edited.has(node.path)) continue;
          const { fingerprint } = await adapter.readFrontmatterWithFingerprint(node.path.slice(6));
          nodeProblems[node.path] = fingerprint;
          if (snapshot.previousNodeProblems[node.path] !== fingerprint)
            invalidProblems.push({
              path: path.resolve(workspaceRoot, node.path),
              problem: node.reason,
            });
        }
        const problems = [
          ...new Map(
            [
              ...invalidProblems,
              ...checked.map((problem) => ({
                path: path.resolve(workspaceRoot, problem.path),
                problem: problem.reason,
              })),
            ].map((problem) => [JSON.stringify(problem), problem]),
          ).values(),
        ];
        const output = formatStopCoverage(pointers, problems);
        await settleSections(systemRoot, checkoutWorkspace, sections);
        await snapshot.settle(nodeProblems);
        return input.stopHookActive === true || !output ? "{}\n" : serialize(output);
      } finally {
        await adapter.close();
      }
    },
    { waitMs: 8000, flush: false },
  );
}
