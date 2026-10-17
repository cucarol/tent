import type { InvalidNativeNode } from "../graph/node-native-capture.js";
import { loadNodeCatalog, type NodeCatalog } from "../graph/node-catalog.js";
import path from "node:path";
import type { FsAdapter } from "../store/adapter.js";
import {
  listCardDocumentHeaders,
  listCardDocuments,
  inspectReceivedCardSourceChanges,
} from "../graph/card-document.js";
import { inspectWorkspaceSync } from "../graph/node-sync.js";
import { nodeNotePath } from "../base/paths.js";

export type WorkspaceSync = Awaited<ReturnType<typeof inspectWorkspaceSync>>;

export async function inspectCurrentContext(
  fs: FsAdapter,
  options: {
    roleId?: string;
    nodes?: Promise<{ invalidNodes: InvalidNativeNode[]; catalog?: NodeCatalog }>;
  } = {},
) {
  const nativeNodes = Promise.resolve(options.nodes);
  const catalog = nativeNodes.then((nodes) => nodes?.catalog ?? loadNodeCatalog(fs));
  const syncPromise = Promise.all([nativeNodes, catalog]).then(([nodes, currentCatalog]) =>
    inspectWorkspaceSync(fs, undefined, nodes?.invalidNodes, currentCatalog),
  );
  // Card queries can finish without consuming these shared results. The main
  // syncPromise below remains responsible for reporting capture/sync failures.
  void catalog.catch(() => undefined);
  const cardOptions = options.roleId ? { roleId: options.roleId, includeOpen: true } : {};
  const headersPromise = listCardDocumentHeaders(fs, cardOptions);
  const cardsPromise = headersPromise.then((headers) =>
    listCardDocuments(fs, cardOptions, headers),
  );
  const [sync, cards, sourceChanges, currentCatalog] = await Promise.all([
    syncPromise,
    cardsPromise,
    headersPromise.then((cards) => inspectReceivedCardSourceChanges(fs, options, cards, catalog)),
    catalog,
  ]);
  const currentIds = new Set(sync.nodes.map((node) => node.nodeId));
  const roots = currentCatalog.rootNodeIds.flatMap((nodeId) => {
    const node = currentCatalog.byId.get(nodeId);
    return node && currentIds.has(nodeId)
      ? [
          {
            nodeId,
            name: node.name,
            type: node.type ?? null,
            path: `.tent/${nodeNotePath(node.path)}`,
          },
        ]
      : [];
  });
  const aheadIds = new Set(sync.nodes.filter((node) => node.ahead).map((node) => node.nodeId));
  const changedCardSources = {
    ...sourceChanges,
    items: sourceChanges.items.filter((item) => aheadIds.has(item.nodeId)),
  };
  return {
    sync,
    cards,
    changedCardSources,
    roots,
  };
}

export type CurrentContext = Awaited<ReturnType<typeof inspectCurrentContext>>;
export async function inspectWorkspaceDrift(fs: FsAdapter) {
  const sync = await inspectWorkspaceSync(fs);
  return {
    items: contextDriftItems({ sync }),
    synchronizationUncertain: sync.nodes.some((node) => node.uncertain),
  };
}

export function contextDriftItems(context: Pick<CurrentContext, "sync">) {
  return context.sync.nodes.flatMap((node) => [
    ...(node.behind
      ? [
          {
            kind: "node-behind" as const,
            nodeId: node.nodeId,
            path: node.path,
            address: node.resource,
            reasons: node.behind.reasons,
          },
        ]
      : []),
    ...(node.ahead
      ? [
          {
            kind: "node-ahead" as const,
            nodeId: node.nodeId,
            path: node.path,
            address: node.resource,
            reasons: node.ahead.reasons,
          },
        ]
      : []),
  ]);
}

type BriefItem = Record<string, string | number | boolean | undefined>;
export type ContextBrief = {
  counts: Pick<WorkspaceSync["counts"], "ahead" | "behind">;
  invalidNodes: InvalidNativeNode[];
  baselineOnlyBehind: number;
  behind: BriefItem[];
  ahead: BriefItem[];
  cardInputs: BriefItem[];
  changedCardSources: BriefItem[];
  roots: CurrentContext["roots"];
  omitted: Record<string, number>;
  synchronizationUncertain?: true;
  cardSourcesUncertain?: true;
  roleId?: string;
};
const shorten = (value: string, length: number) =>
  Array.from(value.replace(/[\r\n\t]/g, " "))
    .slice(0, length)
    .join("");

/** This is a discovery page; omitted details are counted, never misrepresented as complete addresses. */
export function makeContextBrief(
  context: CurrentContext,
  options: { roleId?: string } = {},
): ContextBrief {
  const baselineOnly = (node: WorkspaceSync["nodes"][number]) => {
    const missing = node.materials.filter(
      (material) => material.state !== "current" && material.state !== "unanchored",
    );
    return (
      !!node.behind &&
      !node.stale &&
      missing.length > 0 &&
      missing.every(
        (material) =>
          material.state === "unavailable" &&
          !material.recordedVersion &&
          material.reason?.includes("no retained baseline"),
      )
    );
  };
  const candidates = {
    behind: context.sync.nodes
      .filter((node) => node.behind && !baselineOnly(node))
      .map((node) => ({
        nodeId: node.nodeId,
        path: `.tent/${nodeNotePath(node.path)}`,
        name: shorten(path.posix.basename(node.path), 56),
        reason: shorten(node.behind!.reasons.join("; "), 160),
      })),
    ahead: context.sync.nodes
      .filter((node) => node.ahead)
      .map((node) => ({
        nodeId: node.nodeId,
        path: `.tent/${nodeNotePath(node.path)}`,
        name: shorten(path.posix.basename(node.path), 56),
        reason: shorten(node.ahead!.reasons.join("; "), 160),
      })),
    cardInputs: context.cards.items
      .filter(
        (card) =>
          card.status !== "deprecated" &&
          (card.state === "pending" ||
            (card.state === "consumed" && typeof card.returnTo === "string") ||
            (card.state === "returned" && (!options.roleId || card.returnTo === options.roleId))),
      )
      .sort((a, b) => {
        if ((a.state === "pending") !== (b.state === "pending"))
          return a.state === "pending" ? -1 : 1;
        if (a.state === "pending" && b.state === "pending") {
          const queue = (card: typeof a) =>
            card.target === options.roleId ? "" : String(card.target ?? "~");
          const aq = queue(a),
            bq = queue(b);
          if (aq !== bq) return aq < bq ? -1 : 1;
          return String(a.orderKey ?? "") < String(b.orderKey ?? "") ? -1 : 1;
        }
        return String(b.publishedAt ?? "").localeCompare(String(a.publishedAt ?? ""));
      })
      .map((card) => ({
        cardId: String(card.cardId),
        path: `.tent/cards/${card.cardId}.md`,
        title: shorten(String(card.title ?? card.cardId), 72),
        state: String(card.state),
        ...(typeof card.diagnostic === "string" ? { reason: card.diagnostic } : {}),
        ...(typeof card.returnTo === "string" ? { returnTo: card.returnTo } : {}),
        ...(typeof card.receivedBy === "string" ? { receivedBy: card.receivedBy } : {}),
        ...(typeof card.result === "string" ? { result: card.result } : {}),
      })),
    changedCardSources: context.changedCardSources.items
      .filter((item) =>
        context.sync.nodes.some((node) => node.nodeId === item.nodeId && node.ahead),
      )
      .map((item) => ({
        cardId: item.cardId,
        nodeId: item.nodeId,
        path: `.tent/${item.path ?? item.publishedVersion.path}`,
        state: item.state,
        reason: shorten(item.reason, 160),
      })),
  } satisfies Record<string, BriefItem[]>;
  const brief: ContextBrief = {
    counts: { ahead: context.sync.counts.ahead, behind: context.sync.counts.behind },
    invalidNodes: context.sync.invalidNodes ?? [],
    cardInputs: candidates.cardInputs.filter(
      (item) => item.state === "pending" || item.state === "returned",
    ),
    ahead: [],
    changedCardSources: [],
    behind: [],
    roots: [],
    baselineOnlyBehind: context.sync.nodes.filter(baselineOnly).length,
    omitted: { roots: 0 },
    ...(context.changedCardSources.diagnostics.length ? { cardSourcesUncertain: true } : {}),
    ...(context.sync.nodes.some((node) => node.uncertain)
      ? { synchronizationUncertain: true }
      : {}),
    ...(options.roleId ? { roleId: options.roleId } : {}),
  };
  candidates.cardInputs = candidates.cardInputs.filter(
    (item) => item.state !== "pending" && item.state !== "returned",
  );
  for (const [key, items] of Object.entries(candidates)) brief.omitted[key] = items.length;
  // Keep room for every category before spending the remaining budget by priority.
  const keys: (keyof typeof candidates)[] = ["ahead", "changedCardSources", "cardInputs", "behind"];
  const indices = Object.fromEntries(keys.map((key) => [key, 0])) as Record<
    keyof typeof candidates,
    number
  >;
  const append = (key: keyof typeof candidates) => {
    const item = candidates[key][indices[key]++];
    if (!item) return false;
    brief[key].push(item);
    brief.omitted[key]--;
    if (
      Buffer.byteLength(JSON.stringify(brief) + "\n", "utf8") > 4096 ||
      Buffer.byteLength(formatContextBrief(brief) + "\n", "utf8") > 4096
    ) {
      brief[key].pop();
      brief.omitted[key]++;
      return false;
    }
    return true;
  };
  for (const key of keys) append(key);
  for (const key of keys) while (indices[key] < candidates[key].length) append(key);
  // Root navigation is appended after actionable detail has received its budget.
  brief.roots = context.roots.slice(0, 12);
  brief.omitted.roots = Math.max(0, context.roots.length - brief.roots.length);
  return brief;
}

export function formatContextBrief(brief: ContextBrief): string {
  const lines = [`behind ${brief.counts.behind} · ahead ${brief.counts.ahead}`];
  if (brief.invalidNodes.length) {
    lines.push("Invalid Nodes:");
    for (const node of brief.invalidNodes) lines.push(`- ${node.path}: ${node.reason}`);
  }
  const sections: [
    keyof Pick<ContextBrief, "behind" | "ahead" | "cardInputs" | "changedCardSources">,
    string,
  ][] = [
    ["cardInputs", "Input Cards"],
    ["ahead", "Ahead"],
    ["changedCardSources", "Received Card sources changed; reread current requirements"],
    ["behind", "Behind"],
  ];
  for (const [key, title] of sections) {
    if (!brief[key].length) continue;
    lines.push(title + ":");
    for (const item of brief[key]) {
      const identity =
        key === "changedCardSources"
          ? `${item.cardId} → ${item.nodeId}`
          : String(item.nodeId ?? item.cardId ?? item.address);
      const detail =
        key === "ahead"
          ? `${String(item.name ?? "")}; ${String(item.reason ?? "")}`
          : String(item.reason ?? item.title ?? item.kind ?? item.at ?? item.address ?? "");
      lines.push(
        `- ${identity}${item.path ? ` ${item.path}` : ""}${detail && detail !== identity ? ` ${detail}` : ""}${item.state ? ` [${item.state}]` : ""}${item.receivedBy ? ` received by ${item.receivedBy}` : ""}${item.returnTo ? ` return to ${item.returnTo}` : ""}${item.result ? `: ${item.result}` : ""}`,
      );
    }
  }
  if (brief.baselineOnlyBehind)
    lines.push(
      `${brief.baselineOnlyBehind} behind Nodes have no retained baseline; inspect with tent workspace drift --json.`,
    );
  const omitted = Object.entries(brief.omitted)
    .filter(([key]) => key !== "roots")
    .reduce((sum, [, n]) => sum + n, 0);
  if (omitted)
    lines.push(
      `${omitted} items omitted; use node check, workspace drift or the referenced address.`,
    );
  if (brief.cardSourcesUncertain)
    lines.push("Some received Card sources could not be compared; inspect their published inputs.");
  if (brief.synchronizationUncertain)
    lines.push(
      "Some Nodes changed during inspection; synchronization findings are incomplete. Retry workspace brief.",
    );
  if (brief.roleId)
    lines.push(`Card filter: ${brief.roleId}; synchronization counts cover the whole Workspace.`);
  if (brief.roots.length) {
    lines.push("Root Nodes:");
    for (const node of brief.roots)
      lines.push(`- ${node.name} [${node.type ?? "untyped"}] ${node.path}`);
  }
  if (brief.omitted.roots) lines.push(`+${brief.omitted.roots} more · tent node list`);
  return lines.join("\n");
}
