import type { InvalidNativeNode } from "./node-native-capture.js";
import { withTentMutation, type FsAdapter } from "./adapter.js";
import { contentEtag } from "./etag.js";
import { parseFrontmatter } from "./frontmatter.js";
import {
  materialLocator,
  materialOccurrences,
  isDirectoryMaterial,
  validateMaterialAddresses,
} from "./material.js";
import nodePath from "node:path";
import {
  loadNodeCatalog,
  readCatalogDocument,
  type CatalogNode,
  type NodeCatalog,
} from "./node-catalog.js";
import { NodeWriteError, savePreparedNodeDocumentUnlocked } from "./node-document-write.js";
import { isIncompleteNodeReadEtag, nodeReadRevisionEtag } from "./node-read-basis.js";
import { cardRecordPath, nodeNotePath } from "./paths.js";
import { canonicalDocumentReferences } from "./document-links.js";
import {
  isRequirementNode,
  isOutputNode,
  goalAncestors,
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
import { normalizeTagList } from "./tags.js";
import { ReaderError } from "./context-reader.js";
import { validateNodeName } from "./scaffold.js";
import { listCardDocuments, readCardDocument } from "./card-document.js";
import { readCardGoalIds, type CardProgressInput } from "./card-progress.js";
import { latestGoalAheadTimes } from "./node-ahead-history.js";
import { changedDirectoryFiles } from "./directory-material.js";

export type NodeSyncState = "synced" | "ahead" | "behind" | "unanchored";
export type NodeSyncInspection = {
  nodeId: string;
  path: string;
  type?: string;
  resource?: string;
  goalId?: string;
  goalIds?: string[];
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
    goalId?: string;
    recordedVersion?: string;
    currentVersion?: string;
    state: "current" | "changed" | "unavailable" | "unanchored";
    reason?: string;
    changedFiles?: ReturnType<typeof changedDirectoryFiles>["changedFiles"];
    changedFilesOverflow?: number;
  }[];
  reasons: string[];
};

export async function inspectWorkspaceSync(
  fs: FsAdapter,
  now = new Date().toISOString(),
  invalidNativeNodes: readonly InvalidNativeNode[] = [],
  currentCatalog?: NodeCatalog,
) {
  const catalog = currentCatalog ?? (await loadNodeCatalog(fs));
  return {
    ...(await inspectCatalogNodes(
      fs,
      catalog,
      currentNodes(catalog).filter(
        (node) =>
          !invalidNativeNodes.some(
            (invalid) => invalid.path === `.tent/${nodeNotePath(node.path)}`,
          ),
      ),
      now,
    )),
    invalidNodes: [
      ...invalidNativeNodes,
      ...[...catalog.tree.byPath.values()]
        .filter(
          (node) =>
            node.invalid &&
            !invalidNativeNodes.some(
              (invalid) => invalid.path === `.tent/${nodeNotePath(node.path)}`,
            ),
        )
        .map((node) => ({
          path: `.tent/${nodeNotePath(node.path)}`,
          nodeId: node.id || undefined,
          reason: node.invalidReason ?? "Invalid Node",
        })),
    ],
  };
}

function currentNodes(catalog: Awaited<ReturnType<typeof loadNodeCatalog>>) {
  return [...catalog.byId.values()].filter(
    (n) => !n.archived && !n.invalid && catalog.tree.byPath.get(n.path)!.fm.status !== "deprecated",
  );
}

/** Selected bodies only; output checks may additionally read their implicit goal basis. */
async function inspectCatalogNodes(
  fs: FsAdapter,
  catalog: NodeCatalog,
  selected: CatalogNode[],
  now: string,
  explicitNodeId?: string,
) {
  const records = await retainedNodeRecords(fs);
  const hasRetainedHistory = !!fs.history && (await fs.exists(".git"));
  const goalMismatch = new Map<string, Set<string>>();
  // One inspection observes each declaration once. Shared ancestor materials use
  // that same observation; later inspections always start with an empty map.
  const materialReads = new Map<string, ReturnType<typeof observeNodeMaterials>>();
  const materialObservations: NonNullable<Parameters<typeof observeNodeMaterials>[6]> = new Map();
  const documents = new Map<string, ReturnType<typeof readCatalogDocument>>();
  const readDocument = (node: CatalogNode, retry: boolean) => {
    if (retry) return readCatalogDocument(fs, node);
    let pending = documents.get(node.path);
    if (!pending) {
      const observed = catalog.observedDocuments?.get(node.nodeId);
      pending = observed ? Promise.resolve(observed) : readCatalogDocument(fs, node);
      documents.set(node.path, pending);
    }
    return pending;
  };
  const goalsRead = new Map<string, ReturnType<typeof readGoal>>();
  async function readGoal(goal: CatalogNode, nodeCatalog: typeof catalog, retry: boolean) {
    const { raw } = await readDocument(goal, retry);
    const parsed = {
      data: nodeCatalog.tree.byPath.get(goal.path)!.fm,
      body: raw.slice(goal.header.length),
    };
    return {
      raw,
      parsed,
      version: nodeSemanticFingerprint(
        parsed.data,
        parsed.body,
        nodeNotePath(goal.path),
        nodeCatalog.byId,
      ),
    };
  }
  const observeMaterials = (
    data: Record<string, unknown>,
    documentPath: string,
    nodeCatalog: typeof catalog,
    previous: Parameters<typeof observeNodeMaterials>[5],
    retry: boolean,
  ) => {
    const read = () =>
      observeNodeMaterials(
        fs,
        data,
        documentPath,
        undefined,
        nodeCatalog.byId,
        previous,
        retry || nodeCatalog !== catalog ? undefined : materialObservations,
      );
    if (retry || nodeCatalog !== catalog) return read();
    const key = JSON.stringify([
      documentPath,
      materialOccurrences(data),
      previous?.materials
        .filter((material) => material.repository)
        .map(({ identity, repository }) => ({ identity, repository })),
    ]);
    let pending = materialReads.get(key);
    if (!pending) {
      pending = read();
      materialReads.set(key, pending);
    }
    return pending;
  };
  const comparedMaterials = (
    observations: Awaited<ReturnType<typeof observeNodeMaterials>>,
    bases: import("./node-basis-record.js").NodeBasisRecord["materials"],
    goalId?: string,
    unknownBasis = false,
  ): NodeSyncInspection["materials"] =>
    observations.map((observation) => {
      const basis = bases.find((m) => m.identity === observation.identity);
      const recordedVersion = basis?.version;
      return {
        resource: observation.resource,
        ...(goalId ? { goalId } : {}),
        ...(recordedVersion ? { recordedVersion } : {}),
        ...(observation.version ? { currentVersion: observation.version } : {}),
        ...(observation.directoryFiles &&
        basis?.directoryFiles &&
        observation.version !== recordedVersion
          ? changedDirectoryFiles(basis.directoryFiles, observation.directoryFiles)
          : {}),
        state: recordedVersion
          ? !observation.version
            ? "unavailable"
            : observation.version === recordedVersion
              ? "current"
              : "changed"
          : unknownBasis
            ? "unavailable"
            : "unanchored",
        ...(observation.reason
          ? { reason: observation.reason }
          : unknownBasis && !recordedVersion
            ? {
                reason: goalId
                  ? "Output has no retained baseline for this goal material"
                  : "Node record has no retained baseline for this material",
              }
            : {}),
      };
    });
  const inspect = async (current: CatalogNode) => {
    let nodeCatalog = catalog;
    let result: NodeSyncInspection | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { raw } = await readDocument(current, attempt > 0);
        const data = nodeCatalog.tree.byPath.get(current.path)!.fm;
        const path = nodeNotePath(current.path);
        const record = records[current.nodeId];
        const observations = await observeMaterials(
          data,
          path,
          nodeCatalog,
          record ?? undefined,
          attempt > 0,
        );
        const recordUnreadable = hasRetainedHistory && !record && isOutputNode(data);
        const materials = comparedMaterials(
          observations,
          record?.materials ?? [],
          undefined,
          recordUnreadable,
        );
        const goals = isOutputNode(data) ? goalAncestors(current, nodeCatalog.byId) : [];
        if (recordUnreadable)
          materials.push({
            resource: `/${path}`,
            state: "unavailable",
            reason:
              records[current.nodeId] === null
                ? "Node record unreadable; no retained baseline"
                : "Node record missing; no retained baseline",
          });
        const goalChecks = await Promise.all(
          goals.map(async (goal) => {
            const checkedMaterials: NodeSyncInspection["materials"] = [];
            if (attempt === 0 && !goalsRead.has(goal.path))
              goalsRead.set(goal.path, readGoal(goal, nodeCatalog, false));
            const {
              raw: goalRaw,
              parsed,
              version: currentVersion,
            } = await (attempt > 0 ? readGoal(goal, nodeCatalog, true) : goalsRead.get(goal.path)!);
            const basis = record?.goals?.find((entry) => entry.nodeId === goal.nodeId);
            const recordedVersion = basis?.version;
            checkedMaterials.push({
              resource: `/${nodeNotePath(goal.path)}`,
              goalId: goal.nodeId,
              currentVersion,
              ...(recordedVersion ? { recordedVersion } : {}),
              state: recordedVersion
                ? currentVersion === recordedVersion
                  ? "current"
                  : "changed"
                : hasRetainedHistory
                  ? "unavailable"
                  : "unanchored",
              ...(!recordedVersion && hasRetainedHistory
                ? { reason: "Output has no retained baseline for this ancestor goal" }
                : {}),
            });
            const goalMaterials = await observeMaterials(
              parsed.data,
              nodeNotePath(goal.path),
              nodeCatalog,
              { materials: basis?.materials ?? [] },
              attempt > 0,
            );
            checkedMaterials.push(
              ...comparedMaterials(
                goalMaterials,
                basis?.materials ?? [],
                goal.nodeId,
                hasRetainedHistory && !basis,
              ),
            );
            if ((await fs.readFile(nodeNotePath(goal.path))) !== goalRaw)
              throw new NodeWriteError("ETAG_CONFLICT", "Goal changed during sync inspection");
            return checkedMaterials;
          }),
        );
        materials.push(...goalChecks.flat());
        if ((await fs.readFile(path)) !== raw)
          throw new NodeWriteError("ETAG_CONFLICT", "Node changed during sync inspection");
        const stale = nodeIsStale(data, now);
        const reasons = materials
          .filter(
            (m) =>
              m.state === "changed" ||
              (m.state === "unavailable" && (m.recordedVersion || m.reason)),
          )
          .map(
            (m) =>
              `${m.goalId ? `Goal ${m.goalId}: ` : ""}${m.reason ?? `Material changed`}: ${m.resource}`,
          );
        if (stale) reasons.push(`Content is stale on or after ${data.stale_after}`);
        const anchored =
          materials.some((m) => m.recordedVersion) || nodeVerifications(data).length > 0;
        result = {
          nodeId: current.nodeId,
          path: current.path,
          type: current.type,
          ...(typeof data.resource === "string" ? { resource: data.resource } : {}),
          ...(goals.length
            ? { goalId: goals[0]!.nodeId, goalIds: goals.map((goal) => goal.nodeId) }
            : {}),
          state: reasons.length ? "behind" : anchored ? "synced" : "unanchored",
          ...(reasons.length ? { behind: { reasons: [...reasons] } } : {}),
          trustTier: nodeTrustTier(data),
          stale,
          materials,
          reasons,
        };
        for (const material of materials)
          if (material.goalId && material.state === "changed") {
            const mismatches = goalMismatch.get(material.goalId) ?? new Set<string>();
            mismatches.add(current.nodeId);
            goalMismatch.set(material.goalId, mismatches);
          }
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
    Array.from({ length: Math.min(32, selected.length) }, async () => {
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
  let aheadTimes: Promise<Record<string, string>> | undefined;
  for (const goal of nodes.filter((n) => isRequirementNode({ type: n.type }))) {
    if (goal.uncertain) continue;
    const subtreeOutputs = nodes.filter(
      (n) => isOutputNode(n) && n.path.startsWith(goal.path + "/"),
    );
    const owned = subtreeOutputs;
    const uncertainSubtree = nodes.some((n) => n.uncertain && n.path.startsWith(goal.path + "/"));
    if (!subtreeOutputs.length && !uncertainSubtree) requirementsWithoutOutputs.push(goal.nodeId);
    if (
      (!subtreeOutputs.length && !uncertainSubtree) ||
      owned.some((n) => goalMismatch.get(goal.nodeId)?.has(n.nodeId))
    ) {
      if (!goal.behind) goal.state = "ahead";
      const reasons = [
        subtreeOutputs.length
          ? "An output is behind this goal's content or materials"
          : "Goal subtree has no current output Node",
      ];
      goal.reasons.push(...reasons);
      if (fs.history && hasRetainedHistory)
        goal.aheadSince = (await (aheadTimes ??= latestGoalAheadTimes(fs.history)))[goal.nodeId];
      goal.ahead = { ...(goal.aheadSince ? { since: goal.aheadSince } : {}), reasons };
    } else if (
      !goal.behind &&
      owned.some((node) => {
        const dependencies = node.materials.filter((material) => material.goalId === goal.nodeId);
        return (
          !node.uncertain &&
          dependencies.length > 0 &&
          dependencies.every((material) => material.state === "current")
        );
      })
    )
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

/** Inspect selected outputs together without replaying unrelated goal progress. */
export async function inspectNodesSync(
  fs: FsAdapter,
  nodeIds: readonly string[],
  now = new Date().toISOString(),
) {
  const catalog = await loadNodeCatalog(fs);
  const ids = new Set(nodeIds);
  return (
    await inspectCatalogNodes(
      fs,
      catalog,
      currentNodes(catalog).filter((node) => ids.has(node.nodeId)),
      now,
    )
  ).nodes;
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
  input: {
    resource: string;
    /** The caller's spelling of resource, used only in messages. */
    label?: string;
    name?: string;
    by?: string;
    cardId?: string;
    roleId?: string;
    tags?: string[];
  },
) {
  return withTentMutation(
    fs,
    async () => {
      // A plain output: tags come only from the caller.
      const tags = normalizeTagList(input.tags ?? []);
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
      const localPath =
        locator.kind === "path"
          ? locator.target
          : locator.kind === "uri" && locator.uri.startsWith("file:")
            ? decodeURIComponent(new URL(locator.uri).pathname)
            : undefined;
      const warnings = localPath?.split("/").slice(0, -1).includes(".worktrees")
        ? ["材料位于 .worktrees/：先合并到主检出，再挂产出。"]
        : [];
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
              `Output ${isDirectoryMaterial(locator) ? "directory" : "file"} not found: ${input.label ?? input.resource}. Create the ${isDirectoryMaterial(locator) ? "directory" : "file"} first, then run link-output again.`,
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
      const defaultName = basename && basename !== "." && basename !== ".." ? basename : "Output";
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
          (encoded.startsWith("../") ? encoded : `./${encoded}`) +
          (locator.directory && !encoded.endsWith("/") ? "/" : "") +
          locator.suffix;
      }
      let cardId = input.cardId;
      if (cardId) {
        let card: Record<string, unknown>;
        try {
          card = await readCardDocument(fs, cardId, { includeProgress: false });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            throw new NodeWriteError("INVALID_INPUT", `Card ${cardId} does not exist.`);
          throw error;
        }
        if (card.diagnostic || card.status === "deprecated" || card.state !== "consumed")
          throw new NodeWriteError(
            "INVALID_INPUT",
            "Output response requires a current received Card",
          );
        const pinned = (
          await readCardGoalIds(fs, [
            { cardId, state: "consumed", sources: card.sources } as CardProgressInput,
          ])
        ).get(cardId)!;
        if (
          pinned.diagnostics.length ||
          ![goal, ...goalAncestors(goal, catalog.byId)].some((ancestor) =>
            pinned.goalIds.has(ancestor.nodeId),
          )
        )
          throw new NodeWriteError(
            "INVALID_INPUT",
            "Output response requires a Card source goal in the output's goal chain",
          );
      } else {
        const listed = await listCardDocuments(fs, { state: "consumed" });
        const candidates = listed.items.filter(
          (card) =>
            !card.diagnostic &&
            (card.progress === "received-no-output" || card.progress === "needs-review"),
        );
        const reads = await Promise.all(
          candidates.map(async (card) => {
            const read = (await readCardDocument(fs, String(card.cardId), {
              includeProgress: false,
            })) as Record<string, unknown>;
            if (read.diagnostic || !Array.isArray(read.sources)) return undefined;
            return {
              cardId: String(card.cardId),
              state: "consumed",
              sources: read.sources,
              receivedBy: read.receivedBy,
            } as CardProgressInput & { receivedBy?: string };
          }),
        );
        const cards = reads.filter((card) => card !== undefined);
        const goals = await readCardGoalIds(fs, cards);
        const related = cards.filter((card) => goals.get(card.cardId)!.goalIds.has(goalId));
        const matching = related.filter((card) => input.roleId && card.receivedBy === input.roleId);
        if (matching.length > 1)
          throw new NodeWriteError(
            "INVALID_INPUT",
            `Multiple incomplete Cards point to this goal: ${matching.map((card) => card.cardId).join(", ")}. Choose one with --card <id>.`,
          );
        if (matching.length === 1) cardId = matching[0]!.cardId;
        else if (related.length)
          throw new NodeWriteError(
            "INVALID_INPUT",
            "Incomplete received Cards point to this goal, but no explicit Role matches their receiver. Choose one with --card <id>.",
          );
      }
      const nodeId = await createNodeUnlocked(
        { fs, clock: { now: () => new Date().toISOString() }, tentName: "" },
        {
          parentPath: goal.path,
          name,
          type: "output",
          ...(tags.length ? { tags } : {}),
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
      return {
        nodeId,
        path,
        etag: contentEtag(raw),
        version,
        ...(cardId ? { cardId } : {}),
        ...(warnings.length ? { warnings } : {}),
      };
    },
    { operation: "node.output-link" },
  );
}
