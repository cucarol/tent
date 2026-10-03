import * as z from "zod/v4";
import { withTentMutation, type FsAdapter } from "./adapter.js";
import { resourceSchema } from "./material.js";
import { contentEtag } from "./etag.js";
import { isNodeId } from "./id.js";
import { nodeNotePath } from "./paths.js";
import { loadNodeCatalog, readCatalogDocument } from "./node-catalog.js";
import { captureDocumentUnlocked } from "./document-history.js";
import { documentVersionSchema } from "./git-history.js";
import { MUTATION_LOCK_PATH } from "./paths.js";
import { nodeReadRevisionEtag } from "./node-read-basis.js";

export const materialObservationSchema = z.strictObject({
  resource: resourceSchema,
  canonicalPath: z.string().min(1),
  observedVersion: z.string().regex(/^[a-f0-9]{64}$/),
});
export type MaterialObservation = z.infer<typeof materialObservationSchema>;
const nodeId = z.string().refine(isNodeId);
export const materialCheckInput = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("inspect"), nodeId }),
  z.strictObject({
    action: z.literal("confirm"),
    nodeId,
    expectedPath: z.string().min(1),
    expectedEtag: z.string().min(1),
    materials: z.array(materialObservationSchema).min(1).max(100),
  }),
]);
const recordSchema = z.strictObject({
  nodeId,
  path: z.string(),
  etag: z.string(),
  version: documentVersionSchema.optional(),
  materials: z.array(materialObservationSchema),
  checkedAt: z.string(),
});
export type MaterialCheck = z.infer<typeof recordSchema>;
export type ObserveMaterial = (
  resource: string,
  documentPath: string,
) => Promise<Pick<MaterialObservation, "canonicalPath" | "observedVersion">>;

/** One latest local assertion, keyed by Node; no Session ledger or semantic verdict. */
export async function materialCheck(fs: FsAdapter, input: unknown, observe: ObserveMaterial) {
  const p = materialCheckInput.parse(input),
    file = `temp/material-checks/${p.nodeId}.json`;
  const action = async () => {
    const node = (await loadNodeCatalog(fs)).byId.get(p.nodeId);
    const raw = node ? (await readCatalogDocument(fs, node)).raw : undefined;
    const etag = raw === undefined ? undefined : contentEtag(raw);
    if (p.action === "confirm") {
      if (
        !node ||
        raw === undefined ||
        etag !== nodeReadRevisionEtag(p.expectedEtag) ||
        node.path !== p.expectedPath
      )
        throw new Error("Node changed; reread before confirming checked materials");
      const materials = p.materials;
      if (new Set(materials.map((m) => m.canonicalPath)).size !== materials.length)
        throw new Error("Duplicate checked material");
      for (const m of materials) {
        const current = await observe(m.resource, nodeNotePath(node.path));
        if (
          current.canonicalPath !== m.canonicalPath ||
          current.observedVersion !== m.observedVersion
        )
          throw new Error("Material changed; check the new version before confirming");
      }
      if ((await fs.readFile(nodeNotePath(node.path))) !== raw)
        throw new Error("Node changed during material confirmation");
      const version = await captureDocumentUnlocked(fs, nodeNotePath(node.path), raw);
      const record: MaterialCheck = {
        nodeId: p.nodeId,
        path: node.path,
        etag: etag!,
        ...(version ? { version } : {}),
        materials,
        checkedAt: new Date().toISOString(),
      };
      await fs.writeFile(file, `${JSON.stringify(record)}\n`);
      return { state: "current" as const, record };
    }
    if (!(await fs.exists(file))) return { state: "missing" as const };
    const parsed = recordSchema.safeParse(JSON.parse(await fs.readFile(file)));
    if (!parsed.success)
      return {
        state: "changed" as const,
        reason: "Saved check is incompatible; confirm the materials again",
      };
    const record = parsed.data;
    if (record.nodeId !== p.nodeId) throw new Error("Material check belongs to another Node");
    if (!node || raw === undefined)
      return { state: "unavailable" as const, reason: "Node is missing or invalid", record };
    if (etag !== record.etag || node.path !== record.path)
      return { state: "changed" as const, reason: "Node content or path changed", record };
    for (const m of record.materials) {
      try {
        const current = await observe(m.resource, nodeNotePath(node.path));
        if (
          current.canonicalPath !== m.canonicalPath ||
          current.observedVersion !== m.observedVersion
        )
          return {
            state: "changed" as const,
            reason: "Checked material version or path changed",
            record,
          };
      } catch (error) {
        return { state: "unavailable" as const, reason: String(error), record };
      }
    }
    if (
      !(await fs.exists(nodeNotePath(node.path))) ||
      (await fs.readFile(nodeNotePath(node.path))) !== raw
    )
      return { state: "changed" as const, reason: "Node changed during inspection", record };
    return { state: "current" as const, record };
  };
  if (p.action === "confirm") return withTentMutation(fs, action);
  // Inspect observes current files; only a mutation may resume pending operations.
  return fs.withLock ? fs.withLock(MUTATION_LOCK_PATH, action) : action();
}
