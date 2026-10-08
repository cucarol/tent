import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FsAdapter } from "./adapter.js";
import { listCardDocuments, inspectReceivedCardSourceChanges } from "./card-document.js";
import { inspectWorkspaceSync } from "./node-sync.js";
import { readSessionObservations, type SessionObservationEvent } from "./session-observations.js";
import { localMaterialPath, materialLocator } from "./material.js";
import { nodeNotePath } from "./paths.js";

export type WorkspaceSync = Awaited<ReturnType<typeof inspectWorkspaceSync>>;
export type ObservedFile = {
  sessionId: string;
  address: string;
  kind: "provided" | "read" | "written";
  observedAt: string;
  versionKnown: boolean;
};
export type UnlinkedOutput = {
  address?: string;
  observedAt?: string;
  sessionId?: string;
};

const localKey = (filename: string) => {
  const value = path.resolve(filename);
  return process.platform === "win32" ? value.toLowerCase() : value;
};

/** Compare whole local files; URI fragments remain addresses, never separate fetched material. */
export function materialAddressKey(
  workspaceRoot: string,
  documentPath: string,
  resource: string,
): string | undefined {
  try {
    const locator = materialLocator(resource, documentPath);
    const filename = localMaterialPath(locator, workspaceRoot);
    if (filename !== undefined) return `file:${localKey(filename)}`;
    return locator.kind === "uri" ? locator.uri : undefined;
  } catch {
    return undefined;
  }
}

export function observationAddressKey(workspaceRoot: string, address: string): string | undefined {
  try {
    return address.startsWith("file:")
      ? `file:${localKey(fileURLToPath(address))}`
      : `file:${localKey(path.resolve(workspaceRoot, address))}`;
  } catch {
    return undefined;
  }
}

/** A later observation of one file replaces an earlier version in this current view, not in the log. */
export function observedFiles(events: SessionObservationEvent[]): ObservedFile[] {
  const files: ObservedFile[] = [];
  const seen = new Set<string>();
  for (const event of [...events].sort((a, b) => b.observedAt.localeCompare(a.observedAt))) {
    for (const file of event.files) {
      const identity = JSON.stringify([file.kind, file.address]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      files.push({
        sessionId: event.sessionId,
        address: file.address,
        kind: file.kind,
        observedAt: file.version.observedAt,
        versionKnown: file.version.state === "observed",
      });
    }
  }
  return files;
}

export function findUnlinkedOutputs(
  sync: WorkspaceSync,
  events: SessionObservationEvent[],
  workspaceRoot: string,
): UnlinkedOutput[] {
  // A racing Node may hold the very association we would otherwise call missing.
  if (sync.nodes.some((node) => node.uncertain)) return [];
  const linked = new Set<string>();
  for (const output of sync.outputNodes) {
    if (!output.resource) continue;
    const key = materialAddressKey(workspaceRoot, nodeNotePath(output.path), output.resource);
    if (key) linked.add(key);
  }
  const result: UnlinkedOutput[] = [];
  const seen = new Map<string, UnlinkedOutput>();
  for (const file of observedFiles(events)) {
    if (file.kind !== "written") continue;
    const key = observationAddressKey(workspaceRoot, file.address);
    if (!key || linked.has(key)) continue;
    const existing = seen.get(key);
    if (existing) {
      if (!existing.observedAt || file.observedAt > existing.observedAt) {
        existing.observedAt = file.observedAt;
        existing.sessionId = file.sessionId;
      }
      continue;
    }
    const item = { address: file.address, observedAt: file.observedAt, sessionId: file.sessionId };
    seen.set(key, item);
    result.push(item);
  }
  return result;
}

export async function inspectCurrentContext(
  fs: FsAdapter,
  workspaceRoot: string,
  options: { roleId?: string } = {},
) {
  const cardsPromise = listCardDocuments(fs, {
    ...(options.roleId ? { roleId: options.roleId, includeOpen: true } : {}),
  });
  const [sync, observations, cards, sourceChanges] = await Promise.all([
    inspectWorkspaceSync(fs),
    readSessionObservations(fs),
    cardsPromise,
    cardsPromise.then((cards) => inspectReceivedCardSourceChanges(fs, options, cards)),
  ]);
  const unlinkedOutputs = findUnlinkedOutputs(sync, observations.events, workspaceRoot);
  const aheadIds = new Set(sync.nodes.filter((node) => node.ahead).map((node) => node.nodeId));
  const changedCardSources = {
    ...sourceChanges,
    items: sourceChanges.items.filter((item) => aheadIds.has(item.nodeId)),
  };
  return {
    sync,
    observations,
    cards,
    changedCardSources,
    unlinkedOutputs,
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
            ...(node.ahead.since ? { aheadSince: node.ahead.since } : {}),
          },
        ]
      : []),
  ]);
}

type BriefItem = Record<string, string | number | boolean | undefined>;
export type ContextBrief = {
  counts: Pick<WorkspaceSync["counts"], "ahead" | "behind">;
  behind: BriefItem[];
  ahead: BriefItem[];
  unlinkedOutputs: BriefItem[];
  cardInputs: BriefItem[];
  changedCardSources: BriefItem[];
  omitted: Record<string, number>;
  observationUncertain?: true;
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
  const latestWrite = context.observations.events
    .flatMap((event) => event.files)
    .filter((file) => file.kind === "written")
    .reduce((latest, file) => Math.max(latest, Date.parse(file.version.observedAt)), -Infinity);
  const recentSessions = new Set(
    [
      ...new Set(
        [...context.observations.events]
          .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
          .map((event) => event.sessionId),
      ),
    ].slice(0, 3),
  );
  const cutoff = latestWrite - 7 * 24 * 60 * 60 * 1000;
  const recentUnlinked = context.unlinkedOutputs
    .filter(
      (output) =>
        output.observedAt &&
        Date.parse(output.observedAt) >= cutoff &&
        Date.parse(output.observedAt) <= latestWrite &&
        output.sessionId &&
        recentSessions.has(output.sessionId),
    )
    .sort((a, b) => Date.parse(b.observedAt ?? "") - Date.parse(a.observedAt ?? ""));
  const candidates = {
    behind: context.sync.nodes
      .filter((node) => node.behind)
      .map((node) => ({
        nodeId: node.nodeId,
        name: shorten(path.posix.basename(node.path), 56),
        reason: shorten(node.behind!.reasons.join("; "), 160),
      })),
    ahead: context.sync.nodes
      .filter((node) => node.ahead)
      .map((node) => ({
        nodeId: node.nodeId,
        name: shorten(path.posix.basename(node.path), 56),
        ...(node.ahead!.since
          ? {
              since: node.ahead!.since,
            }
          : { sinceUnknown: true }),
      })),
    cardInputs: context.cards.items
      .filter(
        (card) =>
          !card.diagnostic &&
          card.status !== "deprecated" &&
          (card.state === "pending" ||
            Number(card.goalCount ?? 0) < Number(card.totalGoalCount ?? 0)),
      )
      .sort((a, b) => String(b.publishedAt ?? "").localeCompare(String(a.publishedAt ?? "")))
      .map((card) => ({
        cardId: String(card.cardId),
        title: shorten(String(card.title ?? card.cardId), 72),
        state: String(card.state),
        progress: typeof card.progress === "string" ? card.progress : undefined,
        outputCount: Array.isArray(card.outputNodeIds) ? card.outputNodeIds.length : 0,
        goalCount: Number(card.goalCount ?? 0),
        totalGoalCount: Number(card.totalGoalCount ?? 0),
      })),
    unlinkedOutputs: recentUnlinked.map(({ sessionId: _sessionId, ...output }) => ({ ...output })),
    changedCardSources: context.changedCardSources.items
      .filter((item) =>
        context.sync.nodes.some((node) => node.nodeId === item.nodeId && node.ahead),
      )
      .map((item) => ({
        cardId: item.cardId,
        nodeId: item.nodeId,
        state: item.state,
        reason: shorten(item.reason, 160),
      })),
  } satisfies Record<string, BriefItem[]>;
  const brief: ContextBrief = {
    counts: { ahead: context.sync.counts.ahead, behind: context.sync.counts.behind },
    behind: [],
    ahead: [],
    unlinkedOutputs: [],
    cardInputs: [],
    changedCardSources: [],
    omitted: {},
    ...(context.observations.uncertain ? { observationUncertain: true } : {}),
    ...(context.changedCardSources.diagnostics.length ? { cardSourcesUncertain: true } : {}),
    ...(context.sync.nodes.some((node) => node.uncertain)
      ? { synchronizationUncertain: true }
      : {}),
    ...(options.roleId ? { roleId: options.roleId } : {}),
  };
  for (const [key, items] of Object.entries(candidates)) brief.omitted[key] = items.length;
  brief.omitted.unlinkedOutputs = context.unlinkedOutputs.length;
  // Keep room for every category before spending the remaining budget by priority.
  const keys = Object.keys(candidates) as (keyof typeof candidates)[];
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
  return brief;
}

export function formatContextBrief(brief: ContextBrief): string {
  const lines = [`behind ${brief.counts.behind} · ahead ${brief.counts.ahead}`];
  const sections: [
    keyof Pick<
      ContextBrief,
      "behind" | "ahead" | "unlinkedOutputs" | "cardInputs" | "changedCardSources"
    >,
    string,
  ][] = [
    ["behind", "Behind"],
    ["ahead", "Ahead"],
    ["cardInputs", "Input Cards (reception does not mean completion)"],
    ["unlinkedOutputs", "Recent unrecorded files"],
    ["changedCardSources", "Received Card sources changed; reread current requirements"],
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
          ? `${String(item.name ?? "")}; ${item.since ? `since ${item.since}` : "start time not recorded"}`
          : String(item.reason ?? item.title ?? item.kind ?? item.at ?? item.address ?? "");
      lines.push(
        `- ${identity}${detail && detail !== identity ? ` ${detail}` : ""}${item.progress || item.state ? ` [${item.progress || item.state}${Number(item.totalGoalCount) > 0 ? ` ${item.goalCount}/${item.totalGoalCount}` : ""}]` : ""}`,
      );
    }
  }
  const omitted = Object.values(brief.omitted).reduce((sum, n) => sum + n, 0);
  if (omitted)
    lines.push(
      `${omitted} items omitted; use node check, workspace drift or the referenced address.`,
    );
  if (brief.omitted.unlinkedOutputs)
    lines.push(`${brief.omitted.unlinkedOutputs} older or omitted unrecorded files.`);
  if (brief.observationUncertain)
    lines.push("Session observations are incomplete; only evidenced addresses are shown.");
  if (brief.cardSourcesUncertain)
    lines.push("Some received Card sources could not be compared; inspect their published inputs.");
  if (brief.synchronizationUncertain)
    lines.push(
      "Some Nodes changed during inspection; synchronization and unlinked-output findings are incomplete. Retry workspace brief.",
    );
  if (brief.roleId)
    lines.push(`Card filter: ${brief.roleId}; synchronization counts cover the whole Workspace.`);
  return lines.join("\n");
}
