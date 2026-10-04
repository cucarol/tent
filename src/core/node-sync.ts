import { withTentMutation, type FsAdapter } from "./adapter.js";
import { contentEtag } from "./etag.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { validateMaterialAddresses } from "./material.js";
import { loadNodeCatalog, readCatalogDocument, type CatalogNode } from "./node-catalog.js";
import { NodeWriteError } from "./node-document-write.js";
import { isIncompleteNodeReadEtag, nodeReadRevisionEtag } from "./node-read-basis.js";
import { nodeNotePath } from "./paths.js";
import { captureDocumentUnlocked } from "./document-history.js";
import { canonicalDocumentReferences } from "./document-links.js";
import { ReaderError } from "./context-reader.js";
import {
  isRequirementNode,
  nodeOutputs,
  nodeSemanticFingerprint,
  nodeSyncRecord,
  observeNodeMaterials,
  observeSyncMaterial,
  type SyncBasis,
  type NodeOutput,
  syncMaterialIdentity as identity,
  currentNodeSyncBasis,
  refreshNodeSyncConfirmation,
} from "./node-sync-record.js";

export type NodeSyncState = "synced" | "ahead" | "behind" | "unanchored";
export type NodeSyncInspection = {
  nodeId: string;
  path: string;
  type?: string;
  state: NodeSyncState;
  uncertain?: boolean;
  aheadSince?: string;
  materials: {
    resource: string;
    recordedVersion?: string;
    currentVersion?: string;
    state: "current" | "changed" | "unavailable" | "unanchored";
    reason?: string;
  }[];
  outputs: (NodeOutput & {
    currentVersion?: string;
    possiblyDrifted: boolean;
    reasons: string[];
  })[];
  reasons: string[];
};

function inspectionReadError(error: unknown): never {
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
    throw new NodeWriteError("ETAG_CONFLICT", "Node moved or removed during sync inspection");
  throw error;
}

async function inspect(fs: FsAdapter, node: CatalogNode): Promise<NodeSyncInspection> {
  const { raw } = await readCatalogDocument(fs, node).catch(inspectionReadError);
  const { data, body } = parseFrontmatter(raw),
    path = nodeNotePath(node.path);
  const sync = nodeSyncRecord(data),
    observations = await observeNodeMaterials(fs, data, path);
  const materials: NodeSyncInspection["materials"] = observations.map((observation) => {
    const recorded = sync.materials?.find(
      (m) => identity(m.resource, path) === identity(observation.resource, path),
    );
    const state = !recorded?.version
      ? "unanchored"
      : !observation.version
        ? "unavailable"
        : observation.version === recorded.version
          ? "current"
          : "changed";
    return {
      resource: observation.resource,
      state,
      ...(recorded?.version ? { recordedVersion: recorded.version } : {}),
      ...(observation.version ? { currentVersion: observation.version } : {}),
      ...(observation.reason ? { reason: observation.reason } : {}),
    };
  });
  function basisReasons(basis: SyncBasis): string[] {
    const reasons: string[] = [];
    if (basis.fingerprint !== nodeSemanticFingerprint(data, body))
      reasons.push("Requirement content changed after implementation");
    if (
      basis.materials.length !== observations.length ||
      basis.materials.some(
        (m) => !observations.some((o) => identity(o.resource, path) === identity(m.resource, path)),
      )
    )
      reasons.push("Requirement material declarations changed after implementation");
    for (const material of basis.materials) {
      const current = observations.find(
        (o) => identity(o.resource, path) === identity(material.resource, path),
      );
      if (material.version && current?.version !== material.version)
        reasons.push(
          current?.reason
            ? `${material.resource}: ${current.reason}`
            : `Requirement material changed: ${material.resource}`,
        );
    }
    return reasons;
  }
  const outputs = await Promise.all(
    nodeOutputs(data).map(async (output) => {
      const observation = await observeSyncMaterial(fs, output.resource, path, false);
      const reasons = basisReasons(output.basis);
      if (output.version && observation.version !== output.version)
        reasons.push(
          observation.reason
            ? `${output.resource}: ${observation.reason}`
            : `Output version changed: ${output.resource}`,
        );
      return {
        ...output,
        ...(observation.version ? { currentVersion: observation.version } : {}),
        possiblyDrifted: reasons.length > 0,
        reasons,
      };
    }),
  );
  const reasons = materials
    .filter((m) => m.state === "changed" || m.state === "unavailable")
    .map((m) => `${m.resource}: ${m.reason ?? "Material version changed"}`);
  const materialsChanged = reasons.length > 0;
  for (const output of outputs) reasons.push(...output.reasons);
  if (sync.implemented) reasons.push(...basisReasons(sync.implemented));
  const ahead =
    data.planned === true || (isRequirementNode(data) && !outputs.length && !sync.implemented);
  const anchored =
    materials.some((m) => m.state === "current") ||
    outputs.some((o) => o.version && o.currentVersion === o.version);
  const hasSystemRecord = data.sync !== undefined;
  const state =
    !hasSystemRecord && data.planned !== true
      ? "unanchored"
      : materialsChanged
        ? "behind"
        : data.planned === true
          ? "ahead"
          : reasons.length
            ? "behind"
            : ahead
              ? "ahead"
              : anchored
                ? "synced"
                : "unanchored";
  if ((await fs.readFile(path).catch(inspectionReadError)) !== raw)
    throw new NodeWriteError("ETAG_CONFLICT", "Node changed during sync inspection");
  return {
    nodeId: node.nodeId,
    path: node.path,
    type: node.type,
    state,
    ...(state === "ahead" && sync.aheadSince ? { aheadSince: sync.aheadSince } : {}),
    materials,
    outputs,
    reasons: [...new Set(reasons)],
  };
}

export async function inspectNodeSync(fs: FsAdapter, nodeId: string) {
  const node = (await loadNodeCatalog(fs)).byId.get(nodeId);
  if (!node) throw new NodeWriteError("NOT_FOUND", `Node not found: ${nodeId}`);
  return inspect(fs, node);
}

export async function inspectWorkspaceSync(fs: FsAdapter) {
  const uncertain = new Set<string>();
  const catalog = await loadNodeCatalog(fs),
    active = [...catalog.byId.values()].filter(
      (n) => !n.archived && !n.invalid && parseFrontmatter(n.header).data.status !== "deprecated",
    );
  const inspectedCatalog = new Map(active.map((node) => [node.nodeId, node]));
  const nodes = await Promise.all(
    active.map(async (node): Promise<NodeSyncInspection> => {
      let current = node;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const inspection = await inspect(fs, current);
          inspectedCatalog.set(current.nodeId, current);
          return inspection;
        } catch (error) {
          if (
            !(error instanceof NodeWriteError && error.code === "ETAG_CONFLICT") &&
            !(error instanceof ReaderError && error.code === "SOURCE_CHANGED")
          )
            throw error;
          if (attempt === 0) {
            const refreshed = (await loadNodeCatalog(fs)).byId.get(node.nodeId);
            if (
              refreshed &&
              !refreshed.archived &&
              !refreshed.invalid &&
              parseFrontmatter(refreshed.header).data.status !== "deprecated"
            ) {
              current = refreshed;
              continue;
            }
          }
          uncertain.add(node.nodeId);
          return {
            nodeId: node.nodeId,
            path: current.path,
            type: current.type,
            state: "unanchored",
            uncertain: true,
            materials: [],
            outputs: [],
            reasons: ["Node changed during sync inspection; synchronization state is uncertain"],
          };
        }
      }
      throw new Error("Sync inspection retry exhausted");
    }),
  );
  const counts: Record<NodeSyncState, number> = { synced: 0, ahead: 0, behind: 0, unanchored: 0 };
  for (const node of nodes) counts[node.state]++;
  const linked = new Set(
    nodes.flatMap((node) => node.outputs.map((o) => identity(o.resource, nodeNotePath(node.path)))),
  );
  // Unknown associations cannot establish that an output has no incoming link.
  const unlinkedOutputs = (uncertain.size ? [] : [...inspectedCatalog.values()])
    .filter((node) => {
      if (node.type !== "output" && !node.type?.startsWith("output-")) return false;
      const data = parseFrontmatter(node.header).data;
      return (
        !linked.has(identity(`/${nodeNotePath(node.path)}`, nodeNotePath(node.path))) &&
        !(
          typeof data.resource === "string" &&
          linked.has(identity(data.resource, nodeNotePath(node.path)))
        )
      );
    })
    .map((node) => ({
      nodeId: node.nodeId,
      path: node.path,
      ...(typeof parseFrontmatter(node.header).data.resource === "string"
        ? { resource: parseFrontmatter(node.header).data.resource as string }
        : {}),
    }));
  const requirementsWithoutOutputs = nodes
    .filter(
      (node) =>
        !uncertain.has(node.nodeId) &&
        isRequirementNode({ type: node.type }) &&
        !node.outputs.length,
    )
    .map((node) => node.nodeId);
  return { nodes, counts, unlinkedOutputs, requirementsWithoutOutputs };
}

type MutationInput = { baseEtag: string };
async function mutate(
  fs: FsAdapter,
  nodeId: string,
  input: MutationInput,
  operation: string,
  change: (data: Record<string, unknown>, body: string, path: string) => Promise<void>,
) {
  return withTentMutation(
    fs,
    async () => {
      if (!input.baseEtag)
        throw new NodeWriteError("ETAG_REQUIRED", `${operation} requires baseEtag`);
      if (isIncompleteNodeReadEtag(input.baseEtag))
        throw new NodeWriteError(
          "INCOMPLETE_READ",
          "Sync mutation requires a complete live Node read",
        );
      const node = (await loadNodeCatalog(fs)).byId.get(nodeId);
      if (!node) throw new NodeWriteError("NOT_FOUND", `Node not found: ${nodeId}`);
      const document = await readCatalogDocument(fs, node).catch((error) => {
          if (error instanceof ReaderError && error.code === "SOURCE_CHANGED")
            throw new NodeWriteError("ETAG_CONFLICT", "Node changed during sync lookup");
          throw error;
        }),
        path = nodeNotePath(node.path);
      if (nodeReadRevisionEtag(input.baseEtag) !== document.etag)
        throw new NodeWriteError("ETAG_CONFLICT", "etag conflict");
      const parsed = parseFrontmatter(document.raw);
      await change(parsed.data, parsed.body, path);
      const raw = serializeFrontmatter(parsed.data, parsed.body, parsed.keyOrder);
      if ((await fs.readFile(path)) !== document.raw)
        throw new NodeWriteError("ETAG_CONFLICT", "Node changed during sync mutation");
      const changed = raw !== document.raw;
      if (changed) await fs.writeFile(path, raw);
      const version = await captureDocumentUnlocked(fs, path, raw, { operation });
      return {
        nodeId,
        name: node.name,
        path: node.path,
        raw,
        etag: contentEtag(raw),
        changed,
        version,
      };
    },
    { operation },
  );
}

export function confirmNodeSync(
  fs: FsAdapter,
  nodeId: string,
  input: MutationInput & { implemented?: boolean },
) {
  return mutate(fs, nodeId, input, "node.sync-confirm", async (data, body, path) => {
    const sync = nodeSyncRecord(data),
      basis = await currentNodeSyncBasis(fs, data, body, path);
    sync.materials = basis.materials;
    if (input.implemented === true) {
      if (!(await observeNodeMaterials(fs, data, path)).some((m) => m.version))
        throw new NodeWriteError(
          "INVALID_INPUT",
          "Implementation confirmation requires an observed local material",
        );
      sync.implemented = { ...sync.implemented, ...basis };
      delete data.planned;
    }
    data.sync = sync;
    await refreshNodeSyncConfirmation(fs, data, body, path, undefined, basis);
  });
}

export function linkNodeOutput(
  fs: FsAdapter,
  nodeId: string,
  input: MutationInput & {
    resource: string;
    provenance: "recorded" | "inferred" | "confirmed";
  },
) {
  return mutate(fs, nodeId, input, "node.output-link", async (data, body, path) => {
    if (!isRequirementNode(data))
      throw new NodeWriteError("INVALID_INPUT", "Output associations require a requirement Node");
    if (!["recorded", "inferred", "confirmed"].includes(input.provenance))
      throw new NodeWriteError("INVALID_INPUT", "Invalid output provenance");
    const descriptor = { resource: input.resource };
    await canonicalDocumentReferences(fs, path, descriptor, "");
    validateMaterialAddresses(descriptor, path);
    const observation = await observeSyncMaterial(fs, descriptor.resource, path, false),
      outputs = nodeOutputs(data);
    const previous = outputs.findIndex(
      (output) => identity(output.resource, path) === identity(descriptor.resource, path),
    );
    const basis = await currentNodeSyncBasis(fs, data, body, path);
    const output = {
      ...(previous >= 0 ? outputs[previous] : {}),
      resource: descriptor.resource,
      provenance: input.provenance,
      linkedAt: previous >= 0 ? outputs[previous]!.linkedAt : new Date().toISOString(),
      basis: previous >= 0 ? outputs[previous]!.basis : basis,
      ...(observation.version ? { version: observation.version } : {}),
    };
    if (previous >= 0) outputs[previous] = output;
    else outputs.push(output);
    data.outputs = outputs;
    delete data.planned;
    const sync = nodeSyncRecord(data);
    // Linking records the output's current basis; it does not refresh a prior Node/material check.
    delete sync.aheadSince;
    data.sync = sync;
  });
}
