import { withTentMutation, type FsAdapter } from "./adapter.js";
import { contentEtag } from "./etag.js";
import { parseFrontmatter } from "./frontmatter.js";
import { materialLocator, validateMaterialAddresses } from "./material.js";
import nodePath from "node:path";
import { loadNodeCatalog, readCatalogDocument, type CatalogNode } from "./node-catalog.js";
import { NodeWriteError, savePreparedNodeDocumentUnlocked } from "./node-document-write.js";
import { isIncompleteNodeReadEtag, nodeReadRevisionEtag } from "./node-read-basis.js";
import { cardRecordPath, nodeNotePath } from "./paths.js";
import { canonicalDocumentReferences } from "./document-links.js";
import {
  isRequirementNode,
  isOutputNode,
  nearestGoal,
  nodeSemanticFingerprint,
  observeNodeMaterials,
  retainedNodeRecords,
} from "./node-sync-record.js";
import {
  nodeIsStale,
  nodeTrustTier,
  nodeVerifications,
  type NodeTrustTier,
} from "./node-provenance.js";
import { createNodeUnlocked } from "./ops.js";
import { ReaderError } from "./context-reader.js";
import { validateNodeName } from "./scaffold.js";
import { listCardDocuments, readCardDocument } from "./card-document.js";
import { readCardGoalIds, type CardProgressInput } from "./card-progress.js";

export type NodeSyncState = "synced" | "ahead" | "behind" | "unanchored";
export type NodeSyncInspection = {
  nodeId: string;
  path: string;
  type?: string;
  resource?: string;
  goalId?: string;
  /** Detail summary; the independent attention flags below drive counts and lists. */
  state: NodeSyncState;
  ahead?: { since?: string; reasons: string[] };
  behind?: { reasons: string[] };
  trustTier: NodeTrustTier;
  stale: boolean;
  uncertain?: boolean;
  aheadSince?: string;
  materials: {
    resource: string;
    recordedVersion?: string;
    currentVersion?: string;
    state: "current" | "changed" | "unavailable" | "unanchored";
    reason?: string;
  }[];
  reasons: string[];
};

export async function inspectWorkspaceSync(fs: FsAdapter, now = new Date().toISOString()) {
  const catalog = await loadNodeCatalog(fs);
  return inspectCatalogNodes(fs, catalog, currentNodes(catalog), now);
}

function currentNodes(catalog: Awaited<ReturnType<typeof loadNodeCatalog>>) {
  return [...catalog.byId.values()].filter(
    (n) => !n.archived && !n.invalid && parseFrontmatter(n.header).data.status !== "deprecated",
  );
}

/** Selected bodies only; output checks may additionally read their implicit goal basis. */
async function inspectCatalogNodes(
  fs: FsAdapter,
  catalog: Awaited<ReturnType<typeof loadNodeCatalog>>,
  selected: CatalogNode[],
  now: string,
  explicitNodeId?: string,
) {
  const records = await retainedNodeRecords(fs);
  const goalMismatch = new Set<string>();
  const inspect = async (current: CatalogNode) => {
    let nodeCatalog = catalog;
    let result: NodeSyncInspection | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { raw } = await readCatalogDocument(fs, current);
        const { data, body } = parseFrontmatter(raw);
        const path = nodeNotePath(current.path);
        const record = records[current.nodeId];
        const observations = await observeNodeMaterials(
          fs,
          data,
          path,
          undefined,
          nodeCatalog.byId,
        );
        const materials: NodeSyncInspection["materials"] = observations.map((observation) => {
          const recordedVersion = record?.materials.find(
            (m) => m.identity === observation.identity,
          )?.version;
          const state = recordedVersion
            ? !observation.version
              ? "unavailable"
              : observation.version === recordedVersion
                ? "current"
                : "changed"
            : "unanchored";
          return {
            resource: observation.resource,
            ...(recordedVersion ? { recordedVersion } : {}),
            ...(observation.version ? { currentVersion: observation.version } : {}),
            state,
            ...(observation.reason ? { reason: observation.reason } : {}),
          };
        });
        const goal = isOutputNode(data) ? nearestGoal(current, nodeCatalog.byId) : undefined;
        if (goal) {
          const { raw: goalRaw } = await readCatalogDocument(fs, goal);
          const parsed = parseFrontmatter(goalRaw);
          const currentVersion = nodeSemanticFingerprint(
            parsed.data,
            parsed.body,
            nodeNotePath(goal.path),
            nodeCatalog.byId,
          );
          const recordedVersion =
            record?.goal?.nodeId === goal.nodeId ? record.goal.version : undefined;
          materials.push({
            resource: `/${nodeNotePath(goal.path)}`,
            currentVersion,
            ...(recordedVersion ? { recordedVersion } : {}),
            state: recordedVersion
              ? currentVersion === recordedVersion
                ? "current"
                : "changed"
              : "unanchored",
          });
          if ((await fs.readFile(nodeNotePath(goal.path))) !== goalRaw)
            throw new NodeWriteError("ETAG_CONFLICT", "Goal changed during sync inspection");
        }
        if ((await fs.readFile(path)) !== raw)
          throw new NodeWriteError("ETAG_CONFLICT", "Node changed during sync inspection");
        const stale = nodeIsStale(data, now);
        const reasons = materials
          .filter((m) => m.recordedVersion && m.state !== "current")
          .map((m) => m.reason ?? `Material changed: ${m.resource}`);
        if (stale) reasons.push(`Content is stale on or after ${data.stale_after}`);
        const anchored =
          materials.some((m) => m.recordedVersion) || nodeVerifications(data).length > 0;
        result = {
          nodeId: current.nodeId,
          path: current.path,
          type: current.type,
          ...(typeof data.resource === "string" ? { resource: data.resource } : {}),
          ...(goal ? { goalId: goal.nodeId } : {}),
          state: reasons.length ? "behind" : anchored ? "synced" : "unanchored",
          ...(reasons.length ? { behind: { reasons: [...reasons] } } : {}),
          trustTier: nodeTrustTier(data),
          stale,
          materials,
          reasons,
        };
        if (goal && materials.at(-1)?.state === "changed") goalMismatch.add(current.nodeId);
        break;
      } catch (error) {
        if (
          !(error instanceof ReaderError && error.code === "SOURCE_CHANGED") &&
          !(error instanceof NodeWriteError && error.code === "ETAG_CONFLICT") &&
          (error as NodeJS.ErrnoException).code !== "ENOENT"
        )
          throw error;
        if (attempt === 0) {
          nodeCatalog = await loadNodeCatalog(fs);
          const refreshed = nodeCatalog.byId.get(current.nodeId);
          if (
            refreshed &&
            !refreshed.invalid &&
            (refreshed.nodeId === explicitNodeId ||
              (!refreshed.archived &&
                parseFrontmatter(refreshed.header).data.status !== "deprecated"))
          ) {
            current = refreshed;
            continue;
          }
        }
        result = {
          nodeId: current.nodeId,
          path: current.path,
          type: current.type,
          state: "unanchored",
          trustTier: "unverified",
          stale: false,
          uncertain: true,
          materials: [],
          reasons: [
            `Synchronization state is uncertain: ${error instanceof Error ? error.message : String(error)}`,
          ],
        };
      }
    }
    return result!;
  };
  const nodes: NodeSyncInspection[] = new Array(selected.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, selected.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= selected.length) return;
        nodes[index] = await inspect(selected[index]!);
      }
    }),
  );
  const outputNodes = nodes
    .filter((n) => isOutputNode(n))
    .map((n) => ({
      nodeId: n.nodeId,
      path: n.path,
      ...(n.resource ? { resource: n.resource } : {}),
      ...(n.goalId ? { goalId: n.goalId } : {}),
    }));
  const requirementsWithoutOutputs: string[] = [];
  for (const goal of nodes.filter((n) => isRequirementNode({ type: n.type }))) {
    if (goal.uncertain) continue;
    const subtreeOutputs = outputNodes.filter((n) => n.path.startsWith(goal.path + "/"));
    const owned = nodes.filter((n) => n.goalId === goal.nodeId);
    const uncertainSubtree = nodes.some((n) => n.uncertain && n.path.startsWith(goal.path + "/"));
    if (!subtreeOutputs.length && !uncertainSubtree) requirementsWithoutOutputs.push(goal.nodeId);
    if (
      (!subtreeOutputs.length && !uncertainSubtree) ||
      owned.some((n) => goalMismatch.has(n.nodeId))
    ) {
      if (!goal.behind) goal.state = "ahead";
      const reasons = [
        subtreeOutputs.length
          ? "Owned output is behind the current goal version"
          : "Goal subtree has no current output Node",
      ];
      goal.reasons.push(...reasons);
      if (fs.history && (await fs.exists(".git")))
        goal.aheadSince = await fs.history.firstNodeTime(goal.nodeId);
      goal.ahead = { ...(goal.aheadSince ? { since: goal.aheadSince } : {}), reasons };
    } else if (!goal.behind && owned.length && owned.every((n) => n.state === "synced"))
      goal.state = "synced";
  }
  const counts: Record<NodeSyncState, number> = { synced: 0, ahead: 0, behind: 0, unanchored: 0 };
  for (const node of nodes) {
    if (node.ahead) counts.ahead++;
    if (node.behind) counts.behind++;
    if (node.state === "synced" || node.state === "unanchored") counts[node.state]++;
  }
  return { nodes, counts, requirementsWithoutOutputs, outputNodes };
}

export async function inspectNodeSync(
  fs: FsAdapter,
  nodeId: string,
  now = new Date().toISOString(),
) {
  const catalog = await loadNodeCatalog(fs),
    active = currentNodes(catalog);
  const target = catalog.byId.get(nodeId);
  if (!target) throw new NodeWriteError("NOT_FOUND", `Node not found: ${nodeId}`);
  const selected = isRequirementNode({ type: target.type })
    ? [
        target,
        ...active.filter(
          (n) => n.nodeId !== nodeId && isOutputNode(n) && n.path.startsWith(target.path + "/"),
        ),
      ]
    : [target];
  const node = (await inspectCatalogNodes(fs, catalog, selected, now, nodeId)).nodes.find(
    (n) => n.nodeId === nodeId,
  );
  if (!node) throw new NodeWriteError("NOT_FOUND", `Node not found: ${nodeId}`);
  return node;
}

export function confirmNodeSync(
  fs: FsAdapter,
  nodeId: string,
  input: { baseEtag: string; by?: string },
) {
  return withTentMutation(
    fs,
    async () => {
      if (!input.baseEtag)
        throw new NodeWriteError("ETAG_REQUIRED", "node confirm requires baseEtag");
      if (isIncompleteNodeReadEtag(input.baseEtag))
        throw new NodeWriteError(
          "INCOMPLETE_READ",
          "Confirmation requires a complete live Node read",
        );
      const node = (await loadNodeCatalog(fs)).byId.get(nodeId);
      if (!node) throw new NodeWriteError("NOT_FOUND", `Node not found: ${nodeId}`);
      const { raw } = await readCatalogDocument(fs, node);
      if (nodeReadRevisionEtag(input.baseEtag) !== contentEtag(raw))
        throw new NodeWriteError("ETAG_CONFLICT", "etag conflict");
      return savePreparedNodeDocumentUnlocked(
        fs,
        { id: nodeId, name: node.name, path: node.path },
        raw,
        raw,
        { ...input, confirm: true },
        "node.sync-confirm",
      );
    },
    { operation: "node.sync-confirm" },
  );
}

/** Relative inputs address the Workspace root; / keeps Tent bundle-root semantics. */
export function linkNodeOutput(
  fs: FsAdapter,
  goalId: string,
  input: { resource: string; name?: string; by?: string; cardId?: string },
) {
  return withTentMutation(
    fs,
    async () => {
      const catalog = await loadNodeCatalog(fs),
        goal = catalog.byId.get(goalId);
      if (
        !goal ||
        !isRequirementNode({ type: goal.type }) ||
        goal.archived ||
        parseFrontmatter(goal.header).data.status === "deprecated"
      )
        throw new NodeWriteError("INVALID_INPUT", "Output creation requires a current goal Node");
      const descriptor = { resource: input.resource };
      const addressOwner = "index.md";
      await canonicalDocumentReferences(fs, addressOwner, descriptor, "");
      // index.md lives in .tent, so ../ is the pure namespace address of its Workspace.
      if (
        descriptor.resource === input.resource &&
        !/^(?:\/|[a-z][a-z\d+.-]*:)/i.test(input.resource.trim())
      )
        descriptor.resource = `../${input.resource.trim()}`;
      validateMaterialAddresses(descriptor, addressOwner);
      const locator = materialLocator(descriptor.resource, addressOwner, false);
      if (locator.kind === "path" || (locator.kind === "uri" && locator.uri.startsWith("file:"))) {
        if (!fs.observeMaterial)
          throw new NodeWriteError(
            "INVALID_INPUT",
            "Local output creation requires a material observer",
          );
        try {
          await fs.observeMaterial(descriptor.resource, addressOwner);
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
            throw new NodeWriteError(
              "INVALID_INPUT",
              `Output file not found: ${input.resource}. Create the file first, then run link-output again.`,
            );
          throw error;
        }
      }
      const basename =
        locator.kind === "path"
          ? nodePath.posix.basename(locator.target)
          : locator.kind === "uri"
            ? decodeURIComponent(nodePath.posix.basename(new URL(locator.uri).pathname))
            : "";
      const defaultName = basename || "Output";
      let name = validateNodeName(input.name ?? defaultName, goal.path);
      if (input.name === undefined)
        for (let index = 2; await fs.exists(`${goal.path}/${name}`); index++)
          name = `${defaultName} ${index}`;
      if (locator.kind === "path") {
        const relative = nodePath.posix.relative(
          nodePath.posix.dirname(nodeNotePath(`${goal.path}/${name}`)),
          locator.target,
        );
        const encoded = relative.split("/").map(encodeURIComponent).join("/");
        descriptor.resource =
          (encoded.startsWith("../") ? encoded : `./${encoded}`) + locator.suffix;
      }
      let cardId = input.cardId;
      if (cardId) {
        const card = (await readCardDocument(fs, cardId)) as Record<string, unknown>;
        if (card.diagnostic || card.status === "deprecated")
          throw new NodeWriteError("INVALID_INPUT", "Output response requires a current Card");
      } else {
        const listed = await listCardDocuments(fs, { state: "consumed" });
        const candidates = listed.items.filter(
          (card) => !card.diagnostic && card.progress === "received-no-output",
        );
        const cards = await Promise.all(
          candidates.map(async (card) => {
            const read = (await readCardDocument(fs, String(card.cardId))) as Record<
              string,
              unknown
            >;
            return {
              cardId: String(card.cardId),
              state: "consumed",
              sources: read.sources,
            } as CardProgressInput;
          }),
        );
        const goals = await readCardGoalIds(fs, cards);
        const matching = cards.filter((card) => goals.get(card.cardId)!.goalIds.has(goalId));
        if (matching.length === 1) cardId = matching[0]!.cardId;
      }
      const nodeId = await createNodeUnlocked(
        { fs, clock: { now: () => new Date().toISOString() }, tentName: "" },
        {
          parentPath: goal.path,
          name,
          type: "output",
          resource: descriptor.resource,
          ...(cardId ? { sources: [{ resource: `/${cardRecordPath(cardId)}` }] } : {}),
          by: input.by,
        },
      );
      const path = `${goal.path}/${name}`,
        raw = await fs.readFile(nodeNotePath(path));
      const version =
        fs.history && (await fs.exists(".git"))
          ? { commit: (await fs.history.currentCommit())!, path: nodeNotePath(path) }
          : undefined;
      return { nodeId, path, etag: contentEtag(raw), version };
    },
    { operation: "node.output-link" },
  );
}
