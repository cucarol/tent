import { isDeepStrictEqual } from "node:util";
import * as z from "zod/v4";
import type { FsAdapter } from "./adapter.js";
import { canonicalSha256 } from "./canonical-digest.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import {
  materialIdentity,
  materialLocator,
  materialOccurrences,
  resourceSchema,
} from "./material.js";
import { nodeTypePrimary } from "./node-type.js";

const version = z.string().regex(/^[a-f0-9]{64}$/);
export const syncMaterialSchema = z.looseObject({
  resource: resourceSchema,
  version: version.optional(),
});
export const syncBasisSchema = z.looseObject({
  fingerprint: version,
  materials: z.array(syncMaterialSchema),
});
export const nodeSyncRecordSchema = z.looseObject({
  materials: z.array(syncMaterialSchema).optional(),
  aheadSince: z.string().optional(),
  implemented: syncBasisSchema.optional(),
});
export const nodeOutputSchema = z.looseObject({
  resource: resourceSchema,
  provenance: z.enum(["recorded", "inferred", "confirmed"]),
  version: version.optional(),
  linkedAt: z.string(),
  basis: syncBasisSchema,
});
export type SyncMaterial = z.infer<typeof syncMaterialSchema>;
export type SyncBasis = z.infer<typeof syncBasisSchema>;
export type NodeSyncRecord = z.infer<typeof nodeSyncRecordSchema>;
export type NodeOutput = z.infer<typeof nodeOutputSchema>;
/** Hash embedding is impossible for a changing identity document. */
export class UnanchoredMaterialError extends Error {}

/** The requirement classification lives here, independently of OKF lifecycle. */
export function isRequirementNode(data: Record<string, unknown>): boolean {
  return typeof data.type === "string" && nodeTypePrimary(data.type) === "goal";
}

export function nodeSyncRecord(data: Record<string, unknown>): NodeSyncRecord {
  return data.sync === undefined ? {} : nodeSyncRecordSchema.parse(data.sync);
}

export function nodeOutputs(data: Record<string, unknown>): NodeOutput[] {
  return data.outputs === undefined ? [] : z.array(nodeOutputSchema).parse(data.outputs);
}

export function syncMaterialIdentity(resource: string, documentPath: string) {
  try {
    return materialIdentity(materialLocator(resource, documentPath)) ?? resource;
  } catch {
    return resource;
  }
}

/** Addresses are compared separately so structural relocation never changes the semantic digest. */
export function nodeSemanticFingerprint(data: Record<string, unknown>, body: string): string {
  const semantic = { ...data };
  for (const key of ["id", "title", "sync", "outputs", "planned", "resource"]) delete semantic[key];
  if (Array.isArray(semantic.sources))
    semantic.sources = semantic.sources.map((source: Record<string, unknown>) => {
      const metadata = { ...source };
      delete metadata.resource;
      return metadata;
    });
  return canonicalSha256({ data: semantic, body });
}

export async function observeSyncMaterial(
  fs: FsAdapter,
  resource: string,
  documentPath: string,
  source = true,
): Promise<{ version?: string; reason?: string; unanchored?: boolean }> {
  try {
    const locator = materialLocator(resource, documentPath, source);
    if (locator.kind === "unresolved") return { reason: "Source is not an explicit local address" };
    if (locator.kind === "uri" && !locator.uri.startsWith("file:"))
      return { reason: "Remote material version is unknown; no network request was made" };
    if (locator.kind === "path" && locator.target === documentPath)
      return { reason: "A Node cannot anchor its own embedded material version", unanchored: true };
    if (!fs.observeMaterial) return { reason: "Material observer is unavailable" };
    const explicitResource =
      locator.kind === "path" && !/^(?:\.{1,2}\/|\/)/.test(resource.trim())
        ? `./${resource.trim()}`
        : resource;
    const observation = await fs.observeMaterial(explicitResource, documentPath);
    return { version: version.parse(observation.observedVersion) };
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : String(error),
      ...(error instanceof UnanchoredMaterialError ? { unanchored: true } : {}),
    };
  }
}

export async function observeNodeMaterials(
  fs: FsAdapter,
  data: Record<string, unknown>,
  documentPath: string,
) {
  return Promise.all(
    materialOccurrences(data).map(async ({ resource, field }) => ({
      resource,
      ...(await observeSyncMaterial(fs, resource, documentPath, field === "sources")),
    })),
  );
}

/** System metadata is embedded in the exact identity bytes, so batch rollback covers it too. */
export async function prepareNodeSyncSave(
  fs: FsAdapter,
  documentPath: string,
  raw: string,
  planned?: boolean,
  now = new Date().toISOString(),
  confirm = false,
): Promise<string> {
  const parsed = parseFrontmatter(raw),
    before = structuredClone(parsed.data);
  const sync = nodeSyncRecord(parsed.data);
  nodeOutputs(parsed.data);
  if (planned !== undefined) parsed.data.planned = planned;
  if (parsed.data.planned !== undefined && typeof parsed.data.planned !== "boolean")
    throw new Error("planned must be a boolean");
  if (parsed.data.planned === false) delete parsed.data.planned;
  if (confirm) {
    await refreshNodeSyncConfirmation(fs, parsed.data, parsed.body, documentPath, now);
    return isDeepStrictEqual(before, parsed.data)
      ? raw
      : serializeFrontmatter(parsed.data, parsed.body, parsed.keyOrder);
  }
  const observations = await observeNodeMaterials(fs, parsed.data, documentPath);
  if (observations.length || parsed.data.sync !== undefined || isRequirementNode(parsed.data))
    sync.materials = observations.map(({ resource, version }) => {
      const old = sync.materials?.find(
        (m) =>
          syncMaterialIdentity(m.resource, documentPath) ===
          syncMaterialIdentity(resource, documentPath),
      );
      // Saving unrelated content does not acknowledge a changed or missing material.
      const knownVersion = old?.version ?? version;
      const retained = { ...old, resource };
      delete retained.version;
      return { ...retained, ...(knownVersion ? { version: knownVersion } : {}) };
    });
  const ahead =
    parsed.data.planned === true ||
    (isRequirementNode(parsed.data) && !nodeOutputs(parsed.data).length && !sync.implemented);
  // This is the time we first recorded the plan, never an inferred historical start.
  if (ahead && !sync.aheadSince) sync.aheadSince = now;
  if (!ahead) delete sync.aheadSince;
  if (Object.keys(sync).length) parsed.data.sync = sync;
  else delete parsed.data.sync;
  return isDeepStrictEqual(before, parsed.data)
    ? raw
    : serializeFrontmatter(parsed.data, parsed.body, parsed.keyOrder);
}

export async function currentNodeSyncBasis(
  fs: FsAdapter,
  data: Record<string, unknown>,
  body: string,
  documentPath: string,
): Promise<SyncBasis> {
  const observations = await observeNodeMaterials(fs, data, documentPath);
  const previous = nodeSyncRecord(data).materials;
  return {
    fingerprint: nodeSemanticFingerprint(data, body),
    materials: observations.map(({ resource, version }) => {
      const retained = {
        ...previous?.find(
          (m) =>
            syncMaterialIdentity(m.resource, documentPath) ===
            syncMaterialIdentity(resource, documentPath),
        ),
        resource,
      };
      return { ...retained, ...(version ? { version } : {}) };
    }),
  };
}

/** Both explicit confirmation and confirm-with-save use the final document's basis. */
export async function refreshNodeSyncConfirmation(
  fs: FsAdapter,
  data: Record<string, unknown>,
  body: string,
  documentPath: string,
  now = new Date().toISOString(),
  basis?: SyncBasis,
): Promise<void> {
  const sync = nodeSyncRecord(data);
  basis ??= await currentNodeSyncBasis(fs, data, body, documentPath);
  sync.materials = basis.materials;
  if (sync.implemented) sync.implemented = { ...sync.implemented, ...basis };
  const outputs = nodeOutputs(data);
  if (outputs.length)
    data.outputs = await Promise.all(
      outputs.map(async (output) => {
        const observed = await observeSyncMaterial(fs, output.resource, documentPath, false);
        return {
          ...output,
          basis: { ...output.basis, ...basis },
          ...(observed.version ? { version: observed.version } : {}),
        };
      }),
    );
  if (data.planned === false) delete data.planned;
  const ahead =
    data.planned === true || (isRequirementNode(data) && !outputs.length && !sync.implemented);
  if (ahead && !sync.aheadSince) sync.aheadSince = now;
  if (!ahead) delete sync.aheadSince;
  data.sync = sync;
}

export function assertSyncMetadataRetained(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
) {
  for (const field of ["sync", "outputs"])
    if (!isDeepStrictEqual(previous[field], next[field]))
      throw new Error(
        `node.write cannot change system ${field} metadata; use sync confirmation or output association`,
      );
}
