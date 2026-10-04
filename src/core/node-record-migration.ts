import { withTentMutation, type FsAdapter } from "./adapter.js";
import { loadNodeCatalog, readCatalogDocument } from "./node-catalog.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { nodeNotePath } from "./paths.js";
import {
  retiredNodeFields,
  syncMaterialIdentity,
  retainedNodeRecords,
  nodeBasisRecordSchema,
  isOutputNode,
  nearestGoal,
  nodeSemanticFingerprint,
  type NodeBasisRecord,
} from "./node-sync-record.js";

/** Explicit one-time migration; never runs during reads or ordinary saves. */
export function migrateNodeRecords(fs: FsAdapter) {
  return withTentMutation(
    fs,
    async () => {
      const catalog = await loadNodeCatalog(fs);
      const changes: { path: string; before: string; raw: string }[] = [];
      const nodeRecords: Record<string, NodeBasisRecord> = {};
      const retained = await retainedNodeRecords(fs);
      let materials = 0,
        removedFields = 0;
      for (const node of catalog.byId.values()) {
        const { raw: before } = await readCatalogDocument(fs, node);
        const parsed = parseFrontmatter(before);
        if (
          parsed.data.outputs !== undefined &&
          (!Array.isArray(parsed.data.outputs) || parsed.data.outputs.length)
        )
          throw new Error(
            "Legacy output associations must be resolved before Node record migration",
          );
        const sync = parsed.data.sync as
          | { implemented?: unknown; materials?: Array<{ resource: string; version?: string }> }
          | undefined;
        if (sync?.implemented !== undefined)
          throw new Error(
            "Legacy implemented records must be resolved before Node record migration",
          );
        const path = nodeNotePath(node.path);
        const record = structuredClone(retained[node.nodeId] ?? { materials: [] });
        const legacy = sync?.materials;
        if (legacy !== undefined) {
          if (!Array.isArray(legacy)) throw new Error("Invalid legacy sync materials");
          record.materials = legacy.map((m) => ({
            identity: syncMaterialIdentity(m.resource, path, catalog.byId),
            ...(m.version ? { version: m.version } : {}),
          }));
          nodeRecords[node.nodeId] = nodeBasisRecordSchema.parse(record);
          materials += legacy.length;
        }
        let removed = 0;
        for (const field of retiredNodeFields)
          if (Object.prototype.hasOwnProperty.call(parsed.data, field)) {
            delete parsed.data[field];
            removed++;
          }
        if (Array.isArray(parsed.data.sources))
          for (const source of parsed.data.sources)
            for (const field of ["sha256", "resource_sha256"])
              if (Object.prototype.hasOwnProperty.call(source, field)) {
                delete source[field];
                removed++;
              }
        if (!removed) continue;
        const goal = isOutputNode(parsed.data) ? nearestGoal(node, catalog.byId) : undefined;
        if (goal && !record.goal) {
          const { raw } = await readCatalogDocument(fs, goal),
            goalParsed = parseFrontmatter(raw);
          record.goal = {
            nodeId: goal.nodeId,
            version: nodeSemanticFingerprint(
              goalParsed.data,
              goalParsed.body,
              nodeNotePath(goal.path),
              catalog.byId,
            ),
          };
        }
        nodeRecords[node.nodeId] = nodeBasisRecordSchema.parse(record);
        removedFields += removed;
        changes.push({
          path,
          before,
          raw: serializeFrontmatter(parsed.data, parsed.body, parsed.keyOrder),
        });
      }
      if (!changes.length)
        return { scanned: catalog.byId.size, migrated: 0, materials: 0, removedFields: 0 };
      if (!fs.history || !(await fs.exists(".git")))
        throw new Error("Node record migration requires independent Tent Git history");
      for (const change of changes)
        if ((await fs.readFile(change.path)) !== change.before)
          throw new Error("Node changed during migration preparation");
      const attempted: typeof changes = [];
      try {
        for (const change of changes) {
          attempted.push(change);
          await fs.writeFile(change.path, change.raw);
        }
        for (const change of changes)
          if ((await fs.readFile(change.path)) !== change.raw)
            throw new Error("Node changed during migration save");
        const captured = await fs.history.captureUnlocked(changes, {
          operation: "node.records-migrate",
          nodeRecords,
        });
        return {
          scanned: catalog.byId.size,
          migrated: changes.length,
          materials,
          removedFields,
          ...(captured.commit ? { commit: captured.commit } : {}),
        };
      } catch (error) {
        const conflicts: string[] = [];
        for (const change of attempted.reverse()) {
          const current = await fs.readFile(change.path);
          if (current === change.raw) await fs.writeFile(change.path, change.before);
          else if (current !== change.before) conflicts.push(change.path);
        }
        if (conflicts.length)
          throw new Error(
            `Migration rollback conflicted with external edits: ${conflicts.join(", ")}; original error: ${String(error)}`,
          );
        throw error;
      }
    },
    { operation: "node.records-migrate" },
  );
}
