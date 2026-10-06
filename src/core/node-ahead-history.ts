import type { GitDocumentHistory } from "./git-history.js";
import type { NodeBasisRecord } from "./node-basis-record.js";
import { isNodeId } from "./id.js";
import {
  isImplementationOutputNode,
  isRequirementNode,
  nodeSemanticFingerprint,
} from "./node-sync-record.js";
import {
  historicalNodeCatalog,
  historicalFrontmatterReader,
  historicalFingerprintReader,
  retainedSemanticVersions,
  reinterpretNodeBasisRecords,
} from "./node-semantic-history.js";

/** Derive the last false → true transition from retained identity and material events. */
export function latestGoalAheadTimes(history: GitDocumentHistory): Promise<Record<string, string>> {
  return history.derived("goal-ahead-times", 4, async () => {
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
    const recordAt = new Map<string, number>();
    const goalBasisAt = new Map<string, number>();
    const times: Record<string, string> = {};
    const readFrontmatter = historicalFrontmatterReader();
    const fingerprintOf = historicalFingerprintReader<string>(readFrontmatter);
    const structureOf = (raw: string) => {
      try {
        const { data } = readFrontmatter(raw);
        return JSON.stringify([
          typeof data.type === "string" ? data.type : null,
          data.status === "deprecated",
        ]);
      } catch {
        return "invalid";
      }
    };
    let nodes = historicalNodeCatalog(documents, readFrontmatter);
    let goals = [...nodes.values()];
    let owned = new Map<string, typeof goals>();
    let hasOutputs = new Set<string>();
    let previousAhead = new Set<string>();
    for (const [eventIndex, event] of events.entries()) {
      let structureChanged = false;
      for (const change of event.changes) {
        if (!change.objectId || !isNodeId(change.objectId)) continue;
        const previous = documents.get(change.objectId);
        if (change.after) {
          const raw = rawByVersion.get(`${change.after.commit}:${change.after.path}`);
          if (raw !== undefined) {
            const path = change.after.path.replace(/\/[^/]+$/, "");
            if (
              !previous ||
              previous.path !== path ||
              structureOf(previous.raw) !== structureOf(raw)
            )
              structureChanged = true;
            documents.set(change.objectId, { path, raw });
          }
        } else if (documents.delete(change.objectId)) structureChanged = true;
      }
      const nextRecords = recordEvents[event.commit] ?? {};
      for (const [id, record] of Object.entries(nextRecords)) {
        if (JSON.stringify(records[id]) !== JSON.stringify(record)) recordAt.set(id, eventIndex);
        for (const basis of record.goals ?? []) {
          const previous = records[id]?.goals?.find((entry) => entry.nodeId === basis.nodeId);
          if (JSON.stringify(previous) !== JSON.stringify(basis))
            goalBasisAt.set(`${id}:${basis.nodeId}`, eventIndex);
        }
      }
      Object.assign(
        records,
        semanticIndex ? reinterpretNodeBasisRecords(nextRecords, semanticIndex) : nextRecords,
      );
      // Body and basis changes do not rebuild unchanged hierarchy and membership.
      // This remains a complete replay at each HEAD, not an incremental index.
      if (structureChanged) {
        nodes = historicalNodeCatalog(documents, readFrontmatter);
        const active = [...nodes.values()].filter((node) => !node.archived);
        const outputs = active.filter(isImplementationOutputNode);
        goals = active.filter((node) => isRequirementNode({ type: node.type }));
        hasOutputs = new Set(
          goals
            .filter((goal) => outputs.some((output) => output.path.startsWith(goal.path + "/")))
            .map((goal) => goal.nodeId),
        );
        owned = new Map();
        for (const output of outputs) {
          let parent = output.parentNodeId ? nodes.get(output.parentNodeId) : undefined;
          while (parent) {
            if (!parent.archived && !parent.invalid && isRequirementNode({ type: parent.type })) {
              const list = owned.get(parent.nodeId) ?? [];
              list.push(output);
              owned.set(parent.nodeId, list);
            }
            parent = parent.parentNodeId ? nodes.get(parent.parentNodeId) : undefined;
          }
        }
      }
      const ahead = new Set<string>();
      for (const goal of goals) {
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
          !hasOutputs.has(goal.nodeId) ||
          (owned.get(goal.nodeId) ?? []).some((output) => {
            const outputRecord = records[output.nodeId];
            const chainBasis = outputRecord?.goals?.find((entry) => entry.nodeId === goal.nodeId);
            const basis = chainBasis ?? outputRecord?.goal;
            return (
              basis?.nodeId === goal.nodeId &&
              basis.fingerprintVersion === 2 &&
              (basis.version !== fingerprint ||
                (chainBasis
                  ? (recordAt.get(goal.nodeId) ?? -1) >
                      (goalBasisAt.get(`${output.nodeId}:${goal.nodeId}`) ?? -1) &&
                    chainBasis.materials.some((material) => {
                      const current = records[goal.nodeId]?.materials.find(
                        (entry) => entry.identity === material.identity,
                      );
                      return (
                        material.version && current?.version && material.version !== current.version
                      );
                    })
                  : outputRecord?.goal?.materialsRevision !==
                    records[goal.nodeId]?.materialsRevision))
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
