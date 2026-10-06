import type { GitDocumentHistory } from "./git-history.js";
import type { NodeBasisRecord } from "./node-basis-record.js";
import { parseFrontmatter } from "./frontmatter.js";
import { isNodeId } from "./id.js";
import {
  isOutputNode,
  isRequirementNode,
  nearestGoal,
  nodeSemanticFingerprint,
} from "./node-sync-record.js";
import {
  historicalNodeCatalog,
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
      const nodes = historicalNodeCatalog(documents);
      const active = [...nodes.values()].filter(
        (node) => !node.archived && parseFrontmatter(node.header).data.status !== "deprecated",
      );
      const outputs = active.filter(isOutputNode);
      const ahead = new Set<string>();
      for (const goal of active.filter((node) => isRequirementNode({ type: node.type }))) {
        const parsed = parseFrontmatter(documents.get(goal.nodeId)!.raw);
        const fingerprint = nodeSemanticFingerprint(
          parsed.data,
          parsed.body,
          `${goal.path}/${goal.name}.md`,
          nodes,
        );
        const owned = outputs.filter(
          (output) => nearestGoal(output, nodes)?.nodeId === goal.nodeId,
        );
        if (
          !outputs.some((output) => output.path.startsWith(goal.path + "/")) ||
          owned.some((output) => {
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
