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
import { changedGoals } from "../core/return/stop-goals.js";
import { hasDocumentHistory } from "../core/store/history-port.js";
import { checkNodeWriteProblems } from "../fs/node-write-problems.js";
import { withFileLock } from "../fs/file-lock.js";
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
  return withFileLock(
    `${sectionRoot}.lock`,
    async () => {
      const adapter = new NodeFs(systemRoot);
      // Capture keeps its own adapter so its invalid-edit marks cannot reach the coverage read.
      const captureFs = new NodeFs(systemRoot);
      try {
        const [snapshotResult, coverageResult, captureResult] = await Promise.allSettled([
          observeStopChanges(systemRoot, checkout),
          loadStopCoverage(systemRoot, workspaceRoot, adapter),
          captureNativeNodeEdits(captureFs),
        ]);
        if (snapshotResult.status === "rejected") throw snapshotResult.reason;
        if (coverageResult.status === "rejected") throw coverageResult.reason;
        if (captureResult.status === "rejected") throw captureResult.reason;
        const snapshot = snapshotResult.value;
        const index = coverageResult.value;
        const captured = captureResult.value;
        adapter.invalidNodeEdits = captureFs.invalidNodeEdits;
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
          captured.catalog,
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
        // A listed Node whose file or section is gone: this turn's deletion or rename usually did it.
        const listed = pointers
          .map((node) => path.relative(systemRoot, node.path).split(path.sep).join("/"))
          .filter(
            (file) =>
              present.has(file) && !invalidNativePaths.has(file) && !edited.has(`.tent/${file}`),
          );
        const references = (
          await checkNodeWriteProblems(adapter, workspaceRoot, listed, captured.catalog)
        )
          .filter(
            (problem) =>
              problem.category === "issue" &&
              (problem.kind === "missing-material-file" ||
                problem.kind === "missing-material-section"),
          )
          .map((problem) => ({
            key: `${problem.path}\n${problem.reason}`,
            path: path.resolve(workspaceRoot, problem.path),
            problem: problem.reason,
          }));
        // A Node this Stop did not check keeps its reported problems; one it checked keeps only today's.
        const checkedPaths = new Set(listed.map((file) => `.tent/${file}`));
        const remembered = [...snapshot.previousReferenceProblems].filter((key) => {
          const node = key.slice(0, key.indexOf("\n"));
          return !checkedPaths.has(node) && present.has(node.slice(6));
        });
        const problems = [
          ...new Map(
            [
              ...invalidProblems,
              ...checked.map((problem) => ({
                path: path.resolve(workspaceRoot, problem.path),
                problem: problem.reason,
              })),
              ...references
                .filter(({ key }) => !snapshot.previousReferenceProblems.has(key))
                .map((reference) => ({ path: reference.path, problem: reference.problem })),
            ].map((problem) => [JSON.stringify(problem), problem]),
          ).values(),
        ];
        const history = (await hasDocumentHistory(adapter))
          ? await adapter.history.currentCommit()
          : null;
        // A baseline the history no longer holds (a rebuilt Tent) starts over from this Stop.
        const goals =
          snapshot.previousHistory &&
          history &&
          (await adapter.history.isPublished(snapshot.previousHistory))
            ? await changedGoals(adapter.history, systemRoot, snapshot.previousHistory, history)
            : [];
        const uncovered =
          changedFiles.length > 0 && !selectStopCoverage(index, changedFiles, "all").length;
        const output = formatStopCoverage(pointers, problems, { uncovered, goals });
        await settleSections(systemRoot, checkoutWorkspace, sections);
        await snapshot.settle({
          nodeProblems,
          history,
          referenceProblems: [...remembered, ...references.map(({ key }) => key)],
        });
        return input.stopHookActive === true || !output ? "{}\n" : serialize(output);
      } finally {
        await Promise.all([adapter.close(), captureFs.close()]);
      }
    },
    { waitMs: 8000, flush: false },
  );
}
