import type { GitDocumentHistory } from "./git-history.js";
import type { NodeBasisRecord } from "./node-basis-record.js";
import { isNodeId } from "./id.js";
import { isOutputNode, isRequirementNode, nodeSemanticFingerprint } from "./node-sync-record.js";
import {
  historicalNodeCatalog,
  historicalFrontmatterReader,
  historicalFingerprintReader,
  retainedSemanticVersions,
  reinterpretNodeBasisRecords,
} from "./node-semantic-history.js";

/** Derive the last false → true transition from retained identity and material events. */
export function latestGoalAheadTimes(history: GitDocumentHistory): Promise<Record<string, string>> {
  return history.derived("goal-ahead-times", 2, async () => {
    const events = await history.changesInRange();
    const recordEvents = await history.nodeRecordEvents();
    const hasLegacyGoals = Object.values(recordEvents).some((records) =>
      Object.values(records).some((record) => record.goal && record.goal.fingerprintVersion !== 2),
    );
    const semanticIndex = hasLegacyGoals ? await retainedSemanticVersions(history) : undefined;
    const versions = events.flatMap((event) =>
      event.changes.flatMap((change) => (change.after ? [change.after] : [])),
    );
    const reads = await history.readVersions(versions);
    const rawByVersion = new Map<string, string>();
    reads.forEach((read) => {
      if (read instanceof Error) throw read;
      rawByVersion.set(`${read.version.commit}:${read.version.path}`, read.raw);
    });
    const documents = new Map<string, { path: string; raw: string }>();
    const records: Record<string, NodeBasisRecord> = {};
    const times: Record<string, string> = {};
    const readFrontmatter = historicalFrontmatterReader();
    const fingerprintOf = historicalFingerprintReader<string>(readFrontmatter);
    let previousAhead = new Set<string>();
    for (const event of events) {
      for (const change of event.changes) {
        if (!change.objectId || !isNodeId(change.objectId)) continue;
        if (change.after) {
          const raw = rawByVersion.get(`${change.after.commit}:${change.after.path}`);
          if (raw !== undefined)
            documents.set(change.objectId, {
              path: change.after.path.replace(/\/[^/]+$/, ""),
              raw,
            });
        } else documents.delete(change.objectId);
      }
      const nextRecords = recordEvents[event.commit] ?? {};
      Object.assign(
        records,
        semanticIndex ? reinterpretNodeBasisRecords(nextRecords, semanticIndex) : nextRecords,
      );
      const nodes = historicalNodeCatalog(documents, readFrontmatter);
      // The historical catalog already derives archived from each retained status.
      const active = [...nodes.values()].filter((node) => !node.archived);
      const outputs = active.filter(isOutputNode);
      const owned = new Map<string, typeof outputs>();
      for (const output of outputs) {
        let parent = output.parentNodeId ? nodes.get(output.parentNodeId) : undefined;
        while (parent) {
          if (!parent.archived && !parent.invalid && isRequirementNode({ type: parent.type })) {
            const list = owned.get(parent.nodeId) ?? [];
            list.push(output);
            owned.set(parent.nodeId, list);
            break;
          }
          parent = parent.parentNodeId ? nodes.get(parent.parentNodeId) : undefined;
        }
      }
      const ahead = new Set<string>();
      for (const goal of active.filter((node) => isRequirementNode({ type: node.type }))) {
        const document = documents.get(goal.nodeId)!;
        const fingerprint = fingerprintOf(
          document.raw,
          `${goal.path}/${goal.name}.md`,
          nodes,
          (parsed) =>
            nodeSemanticFingerprint(
              parsed.data,
              parsed.body,
              `${goal.path}/${goal.name}.md`,
              nodes,
            ),
        );
        if (
          !outputs.some((output) => output.path.startsWith(goal.path + "/")) ||
          (owned.get(goal.nodeId) ?? []).some((output) => {
            const basis = records[output.nodeId]?.goal;
            return (
              basis?.nodeId === goal.nodeId &&
              basis.fingerprintVersion === 2 &&
              (basis.version !== fingerprint ||
                basis.materialsRevision !== records[goal.nodeId]?.materialsRevision)
            );
          })
        ) {
          ahead.add(goal.nodeId);
          if (!previousAhead.has(goal.nodeId)) times[goal.nodeId] = event.time;
        } else delete times[goal.nodeId];
      }
      for (const id of previousAhead) if (!ahead.has(id)) delete times[id];
      previousAhead = ahead;
    }
    return times;
  });
}
