import type { InvalidNativeNode } from "../graph/node-native-capture.js";
import { loadNodeCatalog, type NodeCatalog } from "../graph/node-catalog.js";
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
  const run = () => inspectCurrentContextInScope(fs, options);
  return fs.observationScope ? fs.observationScope(run) : run();
}

async function inspectCurrentContextInScope(
  fs: FsAdapter,
  options: {
    roleId?: string;
    nodes?: Promise<{ invalidNodes: InvalidNativeNode[]; catalog?: NodeCatalog }>;
  },
) {
  const nativeNodes = Promise.resolve(options.nodes);
  const catalog = nativeNodes.then((nodes) => nodes?.catalog ?? loadNodeCatalog(fs));
  const syncPromise = Promise.all([nativeNodes, catalog]).then(([nodes, currentCatalog]) =>
    inspectWorkspaceSync(fs, undefined, nodes?.invalidNodes, currentCatalog),
  );
  // Card queries can finish without consuming these shared results. The main
  // syncPromise below remains responsible for reporting capture/sync failures.
  void catalog.catch(() => undefined);
  const cardOptions = {
    unfinishedOnly: true,
    ...(options.roleId ? { roleId: options.roleId, includeOpen: true } : {}),
  };
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
  const draftCount = [...currentCatalog.tree.byId.values()].filter(
    (node) => !node.invalid && !node.archived && node.status === "draft",
  ).length;
  return {
    sync,
    cards,
    changedCardSources,
    roots,
    ...(fs.workspaceRoot ? { workspaceRoot: fs.workspaceRoot } : {}),
    ...(fs.recoveryConflicts?.length ? { recoveryConflicts: [...fs.recoveryConflicts] } : {}),
    ...(draftCount ? { draftCount } : {}),
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
            materials: node.materials,
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
type BriefRead = { total: number; command: string };
export type ContextBrief = {
  counts: Pick<WorkspaceSync["counts"], "ahead" | "behind">;
  invalidNodes: InvalidNativeNode[];
  baselineOnlyBehind: number;
  behind: BriefItem[];
  ahead: BriefItem[];
  cardInputs: BriefItem[];
  changedCardSources: BriefItem[];
  roots: Pick<CurrentContext["roots"][number], "nodeId" | "name" | "type">[];
  omitted: Record<string, number>;
  pendingCardsRead?: BriefRead;
  returnedCardsRead?: BriefRead;
  consumedCardsRead?: BriefRead;
  unknownCardsRead?: BriefRead;
  invalidNodesRead?: BriefRead;
  rootsRead?: BriefRead;
  driftRead?: { command: string };
  changedCardSourcesRead?: BriefRead;
  synchronizationUncertain?: true;
  cardSourcesUncertain?: true;
  recoveryConflicts?: string[];
  roleId?: string;
  drafts?: { count: number; command: string };
};
const shorten = (value: string, length: number) =>
  Array.from(value.replace(/[\r\n\t]/g, " "))
    .slice(0, length)
    .join("");

/** Agent brief queue: pending, returned receipts, then work awaiting return. */
export function compareBriefCards(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  roleId?: string,
) {
  const priority = (card: typeof a) =>
    card.state === "pending" ? 0 : card.state === "returned" ? 1 : 2;
  const group = priority(a) - priority(b);
  if (group) return group;
  if (a.state === "pending" && b.state === "pending") {
    const queue = (card: typeof a) => (card.target === roleId ? "" : String(card.target ?? "~"));
    const aq = queue(a),
      bq = queue(b);
    if (aq !== bq) return aq < bq ? -1 : 1;
    const ao = String(a.orderKey ?? ""),
      bo = String(b.orderKey ?? "");
    if (ao !== bo) return ao < bo ? -1 : 1;
  } else {
    const at = String(a.publishedAt ?? ""),
      bt = String(b.publishedAt ?? "");
    if (at !== bt) return at < bt ? 1 : -1;
  }
  const aid = String(a.cardId),
    bid = String(b.cardId);
  return aid === bid ? 0 : aid < bid ? -1 : 1;
}

export function baselineOnlyBehind(node: WorkspaceSync["nodes"][number]) {
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
}

/** Discovery facts; the Agent brief projection separately bounds its final CLI response. */
export function makeContextBrief(
  context: CurrentContext,
  options: { roleId?: string } = {},
): ContextBrief {
  const command = (args: string[]) =>
    ["tent", ...args, ...(context.workspaceRoot ? ["--workspace", context.workspaceRoot] : [])]
      .map((word) => {
        if (
          /^[a-z0-9_./:\\-]+$/i.test(word) &&
          (process.platform === "win32" || !word.includes("\\"))
        )
          return word;
        return process.platform === "win32"
          ? `'${word.replaceAll("'", "''")}'`
          : `'${word.replaceAll("'", `'"'"'`)}'`;
      })
      .join(" ");
  const cardCommand = (state?: string) =>
    command([
      "card",
      "list",
      ...(options.roleId ? ["--role", options.roleId] : []),
      ...(options.roleId && state === "pending" ? ["--include-open"] : []),
      ...(state ? ["--state", state] : []),
    ]);
  const baselineOnly = baselineOnlyBehind;
  const candidates = {
    cardInputs: context.cards.items
      .filter(
        (card) =>
          card.status !== "deprecated" &&
          (card.state === "pending" ||
            (card.state === "consumed" && typeof card.returnTo === "string") ||
            (card.state === "returned" && (!options.roleId || card.returnTo === options.roleId)) ||
            typeof card.diagnostic === "string"),
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
        title: shorten(String(card.title ?? card.cardId), 72),
        state: typeof card.state === "string" ? card.state : "unknown",
        ...(typeof card.diagnostic === "string" ? { reason: card.diagnostic } : {}),
        ...(typeof card.returnTo === "string" ? { returnTo: card.returnTo } : {}),
        ...(typeof card.receivedBy === "string" ? { receivedBy: card.receivedBy } : {}),
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
  const pending = candidates.cardInputs.filter((item) => item.state === "pending");
  const returned = candidates.cardInputs.filter((item) => item.state === "returned");
  const consumed = candidates.cardInputs.filter((item) => item.state === "consumed");
  const unknown = candidates.cardInputs.filter(
    (item) => item.state !== "pending" && item.state !== "returned" && item.state !== "consumed",
  );
  const invalidNodes = context.sync.invalidNodes ?? [];
  const omitted = (items: readonly unknown[]) => Math.max(0, items.length - 10);
  const shown = { pending: 0, returned: 0, consumed: 0, unknown: 0 };
  const brief: ContextBrief = {
    counts: { ahead: context.sync.counts.ahead, behind: context.sync.counts.behind },
    invalidNodes: invalidNodes.slice(0, 10),
    cardInputs: candidates.cardInputs.filter((item) => {
      const state =
        item.state === "pending" || item.state === "returned" || item.state === "consumed"
          ? item.state
          : "unknown";
      return shown[state]++ < 10;
    }),
    ahead: [],
    changedCardSources: candidates.changedCardSources.slice(0, 10),
    behind: [],
    roots: context.roots.slice(0, 10).map(({ nodeId, name, type }) => ({ nodeId, name, type })),
    baselineOnlyBehind: context.sync.nodes.filter(baselineOnly).length,
    omitted: {
      roots: omitted(context.roots),
      invalidNodes: omitted(invalidNodes),
      ahead: context.sync.counts.ahead,
      changedCardSources: omitted(candidates.changedCardSources),
      cardInputs: [pending, returned, unknown, consumed].reduce(
        (sum, items) => sum + omitted(items),
        0,
      ),
      behind: context.sync.counts.behind,
    },
    ...(context.sync.counts.ahead || context.sync.counts.behind
      ? {
          driftRead: {
            command: command([
              "workspace",
              "drift",
              ...(!context.workspaceRoot ? ["--workspace", "<root>"] : []),
            ]),
          },
        }
      : {}),
    ...(context.recoveryConflicts?.length ? { recoveryConflicts: context.recoveryConflicts } : {}),
    ...(context.changedCardSources.diagnostics.length ? { cardSourcesUncertain: true } : {}),
    ...(context.sync.nodes.some((node) => node.uncertain)
      ? { synchronizationUncertain: true }
      : {}),
    ...(options.roleId ? { roleId: options.roleId } : {}),
  };
  const reads: [
    keyof Pick<
      ContextBrief,
      | "pendingCardsRead"
      | "returnedCardsRead"
      | "consumedCardsRead"
      | "unknownCardsRead"
      | "invalidNodesRead"
      | "rootsRead"
      | "changedCardSourcesRead"
    >,
    readonly unknown[],
    string,
  ][] = [
    ["pendingCardsRead", pending, cardCommand("pending")],
    ["returnedCardsRead", returned, cardCommand("returned")],
    ["consumedCardsRead", consumed, cardCommand("consumed")],
    ["unknownCardsRead", unknown, cardCommand()],
    ["invalidNodesRead", invalidNodes, command(["workspace", "check", "--json"])],
    ["rootsRead", context.roots, command(["node", "list"])],
    ["changedCardSourcesRead", candidates.changedCardSources, cardCommand("consumed")],
  ];
  for (const [key, items, readCommand] of reads)
    if (items.length > 10) brief[key] = { total: items.length, command: readCommand };
  if (context.draftCount)
    brief.drafts = { count: context.draftCount, command: "tent node list --status draft" };
  return brief;
}

export function formatContextBrief(brief: ContextBrief): string {
  const lines = [`behind ${brief.counts.behind} · ahead ${brief.counts.ahead}`];
  if (brief.driftRead) lines.push(brief.driftRead.command);
  if (brief.recoveryConflicts?.length)
    lines.push(
      "Transaction recovery kept external edits:",
      ...brief.recoveryConflicts.map((p) => `- .tent/${p}`),
    );
  if (brief.drafts) lines.push(`${brief.drafts.count} 条还没定 · ${brief.drafts.command}`);
  if (brief.invalidNodes.length) {
    lines.push(
      `Invalid Nodes${brief.invalidNodesRead ? ` (${brief.invalidNodesRead.total} total)` : ""}:`,
    );
    for (const node of brief.invalidNodes) lines.push(`- ${node.path}: ${node.reason}`);
    if (brief.invalidNodesRead)
      lines.push(`+${brief.omitted.invalidNodes} more: ${brief.invalidNodesRead.command}`);
  }
  const sections: [keyof Pick<ContextBrief, "cardInputs" | "changedCardSources">, string][] = [
    ["cardInputs", "Input Cards"],
    ["changedCardSources", "Received Card sources changed; reread current requirements"],
  ];
  for (const [key, title] of sections) {
    if (!brief[key].length) continue;
    const cardTotals =
      key === "cardInputs"
        ? [
            ...(brief.pendingCardsRead ? [`pending ${brief.pendingCardsRead.total}`] : []),
            ...(brief.returnedCardsRead ? [`returned ${brief.returnedCardsRead.total}`] : []),
            ...(brief.consumedCardsRead ? [`consumed ${brief.consumedCardsRead.total}`] : []),
            ...(brief.unknownCardsRead ? [`unknown ${brief.unknownCardsRead.total}`] : []),
          ]
        : [];
    const read = key === "changedCardSources" ? brief.changedCardSourcesRead : undefined;
    lines.push(
      title +
        (cardTotals.length ? ` (${cardTotals.join(", ")})` : read ? ` (${read.total} total)` : "") +
        ":",
    );
    for (const item of brief[key]) {
      const identity =
        key === "changedCardSources"
          ? `${item.cardId} → ${item.nodeId}`
          : String(item.nodeId ?? item.cardId ?? item.address);
      const detail = String(
        item.reason ?? item.title ?? item.kind ?? item.at ?? item.address ?? "",
      );
      lines.push(
        `- ${identity}${item.path ? ` ${item.path}` : ""}${detail && detail !== identity ? ` ${detail}` : ""}${item.state ? ` [${item.state}]` : ""}${item.receivedBy ? ` received by ${item.receivedBy}` : ""}${item.returnTo ? ` return to ${item.returnTo}` : ""}`,
      );
    }
    if (key === "cardInputs") {
      for (const read of [
        brief.pendingCardsRead,
        brief.returnedCardsRead,
        brief.unknownCardsRead,
        brief.consumedCardsRead,
      ]) {
        if (read) lines.push(`+${read.total - 10} more: ${read.command}`);
      }
    } else if (read) lines.push(`+${read.total - 10} more: ${read.command}`);
  }
  if (brief.baselineOnlyBehind)
    lines.push(`${brief.baselineOnlyBehind} behind Nodes have no retained baseline.`);
  if (brief.cardSourcesUncertain)
    lines.push("Some received Card sources could not be compared; inspect their published inputs.");
  if (brief.synchronizationUncertain)
    lines.push(
      "Some Nodes changed during inspection; synchronization findings are incomplete. Retry workspace brief.",
    );
  if (brief.roleId)
    lines.push(`Card filter: ${brief.roleId}; synchronization counts cover the whole Workspace.`);
  if (brief.roots.length) {
    lines.push(`Root Nodes${brief.rootsRead ? ` (${brief.rootsRead.total} total)` : ""}:`);
    for (const node of brief.roots)
      lines.push(`- ${node.nodeId} ${node.name} [${node.type ?? "untyped"}]`);
  }
  if (brief.rootsRead) lines.push(`+${brief.omitted.roots} more: ${brief.rootsRead.command}`);
  return lines.join("\n");
}
