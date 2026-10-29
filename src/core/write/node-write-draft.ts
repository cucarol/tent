import { rewriteMarkdownDestinations } from "../base/links.js";
import { materialOccurrences } from "../base/material.js";
import { makeUniqueNodeId } from "../base/id.js";
import type { OpsEnv } from "../graph/ops-context.js";
import { loadNodeCatalog, readCatalogDocument } from "../graph/node-catalog.js";
import {
  nodeWriteBatchInputSchema,
  withNodeBatchMutation,
  writeNodesBatchUnlocked,
  type NodeWriteBatchInput,
  type NodeWriteBatchResult,
} from "./node-write-batch.js";

export interface NodeDraftStore {
  publish(remaining: NodeWriteBatchInput): Promise<void>;
  rollback(): Promise<void>;
}
type DraftCreate = Extract<NodeWriteBatchInput["items"][number], { op: "create" }>;

/** Rewrite recognized input addresses only; labels and arbitrary prose keep their bytes. */
function replaceReferences(items: DraftCreate[], ids: ReadonlyMap<string, string>) {
  const address = (value: string): string | undefined => {
    const match = /^([^?#]+)(.*)$/.exec(value);
    const id = match && ids.get(match[1]!);
    return id ? id + match![2] : undefined;
  };
  for (const item of items) {
    if (item.parent) item.parent = ids.get(item.parent) ?? item.parent;
    for (const occurrence of materialOccurrences(item)) {
      const next = address(occurrence.resource);
      if (next === undefined) continue;
      if (occurrence.field === "resource") item.resource = next;
      else item.sources![occurrence.index!]!.resource = next;
    }
    if (item.body !== undefined) item.body = rewriteMarkdownDestinations(item.body, address);
  }
}

/** Stable create IDs make every interrupted step resumable through the same ordinary draft. */
export function writeNodesDraft(
  env: OpsEnv,
  supplied: unknown,
  store: NodeDraftStore,
  prepareInput: (input: NodeWriteBatchInput) => Promise<NodeWriteBatchInput> = async (input) =>
    input,
): Promise<NodeWriteBatchResult> {
  return withNodeBatchMutation(env, async () => {
    const parsed = nodeWriteBatchInputSchema.parse(supplied);
    if (parsed.items.some((item) => item.op !== "create"))
      throw new Error(
        "Draft mode accepts create entries only; use node write-many --input-json for updates.",
      );
    const items = parsed.items as DraftCreate[];
    const catalog = await loadNodeCatalog(env.fs);
    const refs = new Map<string, DraftCreate>();
    const reserved = new Set([...catalog.byPath.values()].map((node) => node.nodeId));
    const draftIds = new Set<string>();
    for (const item of items) {
      if (refs.has(item.ref)) throw new Error(`Duplicate batch ref: @${item.ref}`);
      refs.set(item.ref, item);
      if (item.id) {
        if (draftIds.has(item.id)) throw new Error(`Duplicate draft Node id: ${item.id}`);
        draftIds.add(item.id);
        reserved.add(item.id);
      }
    }
    const saved = new Map<DraftCreate, NodeWriteBatchResult["results"][number]>();
    for (const item of items) {
      if (!item.id) continue;
      const live = catalog.byId.get(item.id);
      if (!live) continue;
      const document = await readCatalogDocument(env.fs, live);
      saved.set(item, { nodeId: live.nodeId, path: live.path, etag: document.etag });
    }
    // Identity replay is decisive even if the saved entry's draft body was later blanked.
    const selected = items.filter((item) => saved.has(item) || (item.body ?? "").trim());
    if (!selected.length) return { results: [] };
    const selectedSet = new Set(selected);
    for (const item of selected) {
      if (saved.has(item) || !item.parent?.startsWith("@")) continue;
      const parent = refs.get(item.parent.slice(1));
      if (parent && !selectedSet.has(parent))
        throw new Error(
          `Draft parent ${item.parent} has an empty body; fill its body, then run the same tent node write-many --draft command again.`,
        );
    }
    let allocated = false;
    for (const item of selected) {
      if (item.id) continue;
      item.id = makeUniqueNodeId(reserved, env.rand);
      reserved.add(item.id);
      allocated = true;
    }
    async function checkpoint(next: NodeWriteBatchInput) {
      try {
        await store.publish(next);
      } catch (error) {
        try {
          await store.rollback();
        } catch (rollback) {
          throw new AggregateError(
            [error, rollback],
            `${String(error)}; draft rollback also failed: ${String(rollback)}`,
          );
        }
        throw error;
      }
    }
    // Retain every body before the first Node file can be written.
    if (allocated) await checkpoint({ items });
    const savedRefs = new Map([...saved].map(([item, result]) => [`@${item.ref}`, result.nodeId]));
    const pending = structuredClone(selected.filter((item) => !saved.has(item)));
    replaceReferences(pending, savedRefs);
    const written = pending.length
      ? await writeNodesBatchUnlocked(env, await prepareInput({ items: pending }))
      : { results: [] };
    const resultsById = new Map(written.results.map((result) => [result.nodeId, result]));
    const results = selected.map((item) => saved.get(item) ?? resultsById.get(item.id!)!);
    const completeRefs = new Map(selected.map((item) => [`@${item.ref}`, item.id!]));
    const remaining = structuredClone(items.filter((item) => !selectedSet.has(item)));
    replaceReferences(remaining, completeRefs);
    // Capture has committed. A failed consume retains the ID checkpoint for a safe retry.
    await checkpoint({ items: remaining });
    return { ...written, results };
  });
}
