import type { GitDocumentHistory } from "./git-history.js";
import type { NodeBasisRecord } from "./node-basis-record.js";
import { isNodeId } from "./id.js";
import { canonicalDocumentLinks } from "./document-links.js";
import { materialLocator, materialOccurrences } from "./material.js";
import {
  isOutputNode,
  isRequirementNode,
  nodeMaterialFingerprint,
  nodeSemanticFingerprint,
  syncMaterialIdentity,
} from "./node-sync-record.js";
import {
  historicalIdentityValid,
  historicalNodeCatalog,
  historicalFrontmatterReader,
  historicalFingerprintReader,
} from "./node-semantic-history.js";

/** Derive the last false → true transition from retained identity and material events. */
export function latestGoalAheadTimes(history: GitDocumentHistory): Promise<Record<string, string>> {
  // Version 18: any output satisfies a goal and invalid retained subtrees leave the
  // catalog, so earlier cached transitions are stale.
  return history.derived("goal-ahead-times", 18, async () => {
    const events = await history.changesInRange();
    const recordEvents = await history.nodeRecordEvents();
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
    const documentPathsByNode = new Map<string, string>();
    const records: Record<string, NodeBasisRecord | null> = {};
    const documentAt = new Map<string, number>();
    const materialBasisAt = new Map<string, number>();
    const observedMaterials = new Map<string, { version: string; at: number; known: boolean }>();
    const observedGoals = new Map<string, { version: string; at: number }>();
    const uncertainReceipts = new Map<string, Set<string>>();
    const times: Record<string, string> = {};
    const readFrontmatter = historicalFrontmatterReader();
    const fingerprintOf = historicalFingerprintReader<string>(readFrontmatter);
    const materialFingerprintOf = historicalFingerprintReader<string>(readFrontmatter);
    const materialTargets = new Map<
      string,
      { nodeId?: string; path?: string; suffix: string } | null
    >();
    const rememberFileTargets = (raw: string, documentPath: string) => {
      try {
        for (const { resource, field } of materialOccurrences(readFrontmatter(raw).data)) {
          const locator = materialLocator(resource, documentPath, field === "sources");
          if (locator.kind !== "uri" || !locator.uri.startsWith("file:")) continue;
          const uri = new URL(locator.uri);
          const path = history.localFileUriDocumentPath(locator.uri);
          materialTargets.set(
            syncMaterialIdentity(resource, documentPath),
            path ? { path, suffix: uri.search + uri.hash } : null,
          );
        }
      } catch {
        /* Invalid declarations cannot locate retained material bytes. */
      }
    };
    const materialTarget = (identity: string) => {
      if (materialTargets.has(identity)) return materialTargets.get(identity);
      let target: { nodeId?: string; path?: string; suffix: string } | null = null;
      try {
        if (identity.startsWith("node:")) {
          const match = /^node:(node-[^?#]+)(.*)$/.exec(identity);
          if (match) target = { nodeId: match[1], suffix: match[2]! };
        } else {
          const [kind, path, suffix] = JSON.parse(identity);
          if (kind === "path") target = { path, suffix: suffix ?? "" };
          else if (kind === "uri" && path.startsWith("file:")) {
            const uri = new URL(path);
            target = {
              path: history.localFileUriDocumentPath(path),
              suffix: uri.search + uri.hash,
            };
          }
        }
      } catch {
        // An unresolved or external identity cannot supply retained material bytes.
      }
      materialTargets.set(identity, target);
      return target;
    };
    const structureOf = (raw: string) => {
      try {
        const parsed = readFrontmatter(raw);
        return JSON.stringify([
          typeof parsed.data.type === "string" ? parsed.data.type : null,
          parsed.data.status === "deprecated",
          historicalIdentityValid(parsed),
        ]);
      } catch {
        return "invalid";
      }
    };
    let nodes = historicalNodeCatalog(documents, readFrontmatter);
    let nodesByDocumentPath = new Map<string, string>();
    const retainedNodesByDocumentPath = new Map<string, string>();
    let goals = [...nodes.values()];
    let owned = new Map<string, typeof goals>();
    let hasOutputs = new Set<string>();
    let previousAhead = new Set<string>();
    let previousUnknown = new Set<string>();
    for (const [eventIndex, event] of events.entries()) {
      let structureChanged = false;
      // Resolve old Node-ID aliases against this capture's final paths, including
      // forward creations in a batch, without another catalog or history scan.
      for (const change of event.changes) {
        if (!change.objectId || !isNodeId(change.objectId)) continue;
        if (!change.after) documentPathsByNode.delete(change.objectId);
      }
      for (const change of event.changes) {
        if (change.objectId && isNodeId(change.objectId) && change.after)
          documentPathsByNode.set(change.objectId, change.after.path);
      }
      const acknowledgedOutputs = new Set(event.acknowledgedOutputIds ?? []);
      const ambiguousOutputs = new Set<string>();
      for (const change of event.changes) {
        if (!change.objectId || !isNodeId(change.objectId)) continue;
        const previous = documents.get(change.objectId);
        if (change.after) {
          const raw = rawByVersion.get(`${change.after.commit}:${change.after.path}`);
          if (raw !== undefined) {
            if (
              previous &&
              event.acknowledgedOutputIds === undefined &&
              (event.operation === "node.write" || event.operation === "node.write-many")
            ) {
              try {
                const parsed = readFrontmatter(raw);
                if (isOutputNode(parsed.data)) {
                  const beforeBody = readFrontmatter(previous.raw).body;
                  const path = change.after.path;
                  if (
                    beforeBody.replace(/\r\n?/g, "\n") !== parsed.body.replace(/\r\n?/g, "\n") &&
                    nodeSemanticFingerprint(
                      {},
                      canonicalDocumentLinks(beforeBody, documentPathsByNode, path),
                      path,
                      nodes,
                    ) !==
                      nodeSemanticFingerprint(
                        {},
                        canonicalDocumentLinks(parsed.body, documentPathsByNode, path),
                        path,
                        nodes,
                      )
                  )
                    acknowledgedOutputs.add(change.objectId);
                  else ambiguousOutputs.add(change.objectId);
                }
              } catch {
                // Invalid bytes cannot prove a full output rewrite.
              }
            }
            const path = change.after.path.replace(/\/[^/]+$/, "");
            if (
              !previous ||
              previous.path !== path ||
              structureOf(previous.raw) !== structureOf(raw)
            )
              structureChanged = true;
            documents.set(change.objectId, { path, raw });
            rememberFileTargets(raw, change.after.path);
            documentAt.set(change.objectId, eventIndex);
          }
        } else {
          documentAt.set(change.objectId, eventIndex);
          if (documents.delete(change.objectId)) structureChanged = true;
        }
      }
      const nextRecords = recordEvents[event.commit] ?? {};
      const replacedRecords = new Map(Object.keys(nextRecords).map((id) => [id, records[id]]));
      for (const [id, record] of Object.entries(nextRecords)) {
        if (!record) continue;
        for (const basis of record.goals ?? []) {
          const previous = records[id]?.goals?.find((entry) => entry.nodeId === basis.nodeId);
          // Initial acquisition or a changed goal version proves a successful goal read.
          // It observes semantic bytes without acknowledging unchanged material receipts.
          if (!previous || previous.version !== basis.version)
            observedGoals.set(basis.nodeId, { version: basis.version, at: eventIndex });
          for (const material of basis.materials) {
            const old = previous?.materials.find((entry) => entry.identity === material.identity);
            if (!old || old.version !== material.version) {
              materialBasisAt.set(
                JSON.stringify([id, basis.nodeId, material.identity]),
                eventIndex,
              );
              // A newly acquired or changed version cannot be an unavailable fallback.
              if (material.version && material.fingerprintVersion === 2)
                observedMaterials.set(material.identity, {
                  version: material.version,
                  at: eventIndex,
                  known: true,
                });
            }
          }
        }
      }
      Object.assign(records, nextRecords);
      // Confirmation can resample a material back to the same version, with no record delta.
      // Only explicit confirmation and full output rewrites acknowledge unchanged receipts.
      if (event.acknowledgedOutputIds === undefined && event.operation === "node.sync-confirm")
        for (const id of event.objectIds) acknowledgedOutputs.add(id);
      for (const id of ambiguousOutputs)
        uncertainReceipts.set(id, new Set(records[id]?.goals?.map((basis) => basis.nodeId) ?? []));
      for (const id of acknowledgedOutputs) {
        uncertainReceipts.delete(id);
        const previous = replacedRecords.has(id) ? replacedRecords.get(id) : records[id];
        for (const basis of records[id]?.goals ?? []) {
          // Goal bytes must have been read and parsed successfully to save this acknowledgment.
          observedGoals.set(basis.nodeId, { version: basis.version, at: eventIndex });
          const oldBasis = previous?.goals?.find((entry) => entry.nodeId === basis.nodeId);
          for (const material of basis.materials) {
            materialBasisAt.set(JSON.stringify([id, basis.nodeId, material.identity]), eventIndex);
            if (material.version && material.fingerprintVersion === 2) {
              const old = oldBasis?.materials.find((entry) => entry.identity === material.identity);
              const observation = observedMaterials.get(material.identity);
              // Failed observations retain their old basis; only a version delta proves success.
              if (observation?.at !== eventIndex || !observation.known)
                observedMaterials.set(material.identity, {
                  version: material.version,
                  at: eventIndex,
                  known: old?.version !== material.version,
                });
            }
          }
        }
      }
      // Body and basis changes do not rebuild unchanged hierarchy and membership.
      // This remains a complete replay at each HEAD, not an incremental index.
      if (structureChanged) {
        nodes = historicalNodeCatalog(documents, readFrontmatter);
        nodesByDocumentPath = new Map(
          [...nodes.values()].map((node) => [`${node.path}/${node.name}.md`, node.nodeId]),
        );
        for (const [path, id] of nodesByDocumentPath) retainedNodesByDocumentPath.set(path, id);
        const active = [...nodes.values()].filter((node) => !node.archived);
        const outputs = active.filter(isOutputNode);
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
            if (!parent.invalid && isRequirementNode({ type: parent.type })) {
              const list = owned.get(parent.nodeId) ?? [];
              list.push(output);
              owned.set(parent.nodeId, list);
            }
            parent = parent.parentNodeId ? nodes.get(parent.parentNodeId) : undefined;
          }
        }
      }
      const ahead = new Set<string>();
      const unknown = new Set<string>();
      for (const goal of goals) {
        const document = documents.get(goal.nodeId)!;
        const goalObservation = observedGoals.get(goal.nodeId);
        const observedGoal =
          goalObservation && goalObservation.at > (documentAt.get(goal.nodeId) ?? -1);
        const fingerprint = observedGoal
          ? goalObservation.version
          : fingerprintOf(document.raw, `${goal.path}/${goal.name}.md`, nodes, (parsed) =>
              nodeSemanticFingerprint(
                parsed.data,
                parsed.body,
                `${goal.path}/${goal.name}.md`,
                nodes,
              ),
            );
        let retainedAhead = !hasOutputs.has(goal.nodeId);
        let currentAhead = retainedAhead;
        let uncertainMaterial = false;
        outputs: for (const output of owned.get(goal.nodeId) ?? []) {
          if (retainedAhead) break;
          const outputRecord = records[output.nodeId];
          const basis = outputRecord?.goals?.find((entry) => entry.nodeId === goal.nodeId);
          if (basis?.nodeId !== goal.nodeId || basis.fingerprintVersion !== 2) continue;
          if (basis.version !== fingerprint) {
            currentAhead = true;
            if (!observedGoal) {
              retainedAhead = true;
              break;
            }
          }
          for (const material of basis.materials) {
            if (!material.version || material.fingerprintVersion !== 2) continue;
            const target = materialTarget(material.identity);
            const nodeId =
              target?.nodeId ??
              (target?.path &&
                (nodesByDocumentPath.get(target.path) ??
                  retainedNodesByDocumentPath.get(target.path)));
            const document = nodeId && documents.get(nodeId);
            const observation = observedMaterials.get(material.identity);
            // An unchanged receipt can be a failed observation's preserved basis.
            // Neither matching nor differing bases prove false without readable bytes.
            if (observation && observation.at > (nodeId ? (documentAt.get(nodeId) ?? -1) : -1)) {
              if (!observation.known) uncertainMaterial = true;
              else if (material.version !== observation.version) currentAhead = true;
              continue;
            }
            // Receipts can prove an external mismatch, but only retained Node
            // bytes can establish its time. A former path cannot follow a moved ID.
            if (!target || !nodeId) continue;
            if (
              !document ||
              !nodes.has(nodeId) ||
              (target.path && nodesByDocumentPath.get(target.path) !== nodeId) ||
              // An output can acknowledge live bytes not yet captured for the material Node.
              // Its older retained document cannot prove a later transition.
              (documentAt.get(nodeId) ?? -1) <
                (materialBasisAt.get(
                  JSON.stringify([output.nodeId, goal.nodeId, material.identity]),
                ) ?? -1)
            ) {
              uncertainMaterial = true;
              continue;
            }
            const path = `${document.path}/${nodes.get(nodeId)!.name}.md`;
            const locator = {
              kind: "path" as const,
              anchor: "bundle" as const,
              target: path,
              suffix: target.suffix,
            };
            try {
              if (
                material.version !==
                materialFingerprintOf(
                  document.raw,
                  path,
                  nodes,
                  () => nodeMaterialFingerprint(document.raw, locator, nodes),
                  locator.suffix,
                )
              ) {
                currentAhead = retainedAhead = true;
                break outputs;
              }
            } catch {
              // Unreadable retained bytes are unknown, never a proven false state.
              uncertainMaterial = true;
              continue;
            }
          }
        }
        if (currentAhead) {
          ahead.add(goal.nodeId);
          if (
            (owned.get(goal.nodeId) ?? []).some((output) =>
              uncertainReceipts.get(output.nodeId)?.has(goal.nodeId),
            ) &&
            !(owned.get(goal.nodeId) ?? []).some((output) => {
              if (uncertainReceipts.get(output.nodeId)?.has(goal.nodeId)) return false;
              const record = records[output.nodeId];
              const basis = record?.goals?.find((entry) => entry.nodeId === goal.nodeId);
              return (
                basis?.nodeId === goal.nodeId &&
                basis.fingerprintVersion === 2 &&
                basis.version !== fingerprint
              );
            })
          )
            delete times[goal.nodeId];
          else if (previousUnknown.has(goal.nodeId)) delete times[goal.nodeId];
          else if (!previousAhead.has(goal.nodeId)) {
            if (retainedAhead) times[goal.nodeId] = event.time;
            else delete times[goal.nodeId];
          }
        } else if (uncertainMaterial) {
          unknown.add(goal.nodeId);
          delete times[goal.nodeId];
        } else {
          delete times[goal.nodeId];
          for (const output of owned.get(goal.nodeId) ?? [])
            uncertainReceipts.get(output.nodeId)?.delete(goal.nodeId);
        }
      }
      for (const id of previousAhead) if (!ahead.has(id)) delete times[id];
      previousAhead = ahead;
      previousUnknown = unknown;
    }
    return times;
  });
}
