import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FsAdapter } from "./adapter.js";
import { listCardDocuments } from "./card-document.js";
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
  nodeId?: string;
  path?: string;
  observedAt?: string;
  sessionId?: string;
  modifiedAt?: string;
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
  for (const node of sync.nodes)
    for (const output of node.outputs) {
      const key = materialAddressKey(workspaceRoot, nodeNotePath(node.path), output.resource);
      if (key) linked.add(key);
    }
  const result: UnlinkedOutput[] = [];
  const seen = new Map<string, UnlinkedOutput>();
  for (const output of sync.unlinkedOutputs) {
    const key = output.resource
      ? materialAddressKey(workspaceRoot, nodeNotePath(output.path), output.resource)
      : undefined;
    if (key && (linked.has(key) || seen.has(key))) continue;
    const item: UnlinkedOutput = {
      nodeId: output.nodeId,
      path: output.path,
      ...(output.resource ? { address: output.resource } : {}),
    };
    if (key) seen.set(key, item);
    result.push(item);
  }
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
  const [sync, observations, cards] = await Promise.all([
    inspectWorkspaceSync(fs),
    readSessionObservations(fs),
    listCardDocuments(fs, {
      ...(options.roleId ? { roleId: options.roleId, includeOpen: true } : {}),
    }),
  ]);
  const unlinkedOutputs = findUnlinkedOutputs(sync, observations.events, workspaceRoot);
  const modified = await fs.history?.latestCommitTimes(
    unlinkedOutputs.flatMap((output) => (output.path ? [nodeNotePath(output.path)] : [])),
  );
  for (const output of unlinkedOutputs) {
    const time = output.path && modified?.get(nodeNotePath(output.path));
    if (time) output.modifiedAt = time;
  }
  return {
    sync,
    observations,
    cards,
    unlinkedOutputs,
  };
}

export type CurrentContext = Awaited<ReturnType<typeof inspectCurrentContext>>;
export async function inspectWorkspaceDrift(fs: FsAdapter, workspaceRoot: string) {
  const [sync, observations] = await Promise.all([
    inspectWorkspaceSync(fs),
    readSessionObservations(fs),
  ]);
  const unlinkedOutputs = findUnlinkedOutputs(sync, observations.events, workspaceRoot);
  return {
    items: contextDriftItems({ sync, unlinkedOutputs }),
    observationUncertain: observations.uncertain,
    synchronizationUncertain: sync.nodes.some((node) => node.uncertain),
  };
}

export function contextDriftItems(context: Pick<CurrentContext, "sync" | "unlinkedOutputs">) {
  return [
    ...context.unlinkedOutputs.map((output) => ({ kind: "unlinked-output" as const, ...output })),
    ...context.sync.nodes.flatMap((node) =>
      node.outputs
        .filter((output) => output.possiblyDrifted)
        .map((output) => ({
          kind: "requirement-changed" as const,
          nodeId: node.nodeId,
          path: node.path,
          address: output.resource,
          reasons: output.reasons,
        })),
    ),
    ...context.sync.requirementsWithoutOutputs.map((nodeId) => ({
      kind: "requirement-without-output" as const,
      nodeId,
    })),
  ];
}

type BriefItem = Record<string, string | number | boolean | undefined>;
export type ContextBrief = {
  counts: WorkspaceSync["counts"];
  behind: BriefItem[];
  ahead: BriefItem[];
  recentInputs: BriefItem[];
  recentOutputs: BriefItem[];
  unlinkedOutputs: BriefItem[];
  cardInputs: BriefItem[];
  omitted: Record<string, number>;
  observationUncertain?: true;
  synchronizationUncertain?: true;
  roleId?: string;
};
const shorten = (value: string, length: number) =>
  Array.from(value.replace(/[\r\n\t]/g, " "))
    .slice(0, length)
    .join("");

/** This is a discovery page; omitted details are counted, never misrepresented as complete addresses. */
export function makeContextBrief(
  context: CurrentContext,
  options: { roleId?: string; now?: string } = {},
): ContextBrief {
  const now = Date.parse(options.now ?? new Date().toISOString());
  const files = observedFiles(context.observations.events);
  const recentSessions = new Set(
    [
      ...new Set(
        [...context.observations.events]
          .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
          .map((event) => event.sessionId),
      ),
    ].slice(0, 3),
  );
  const cutoff = now - 7 * 24 * 60 * 60 * 1000;
  const recentUnlinked = context.unlinkedOutputs
    .filter(
      (output) =>
        (output.modifiedAt && Date.parse(output.modifiedAt) >= cutoff) ||
        (output.observedAt &&
          Date.parse(output.observedAt) >= cutoff &&
          output.sessionId &&
          recentSessions.has(output.sessionId)),
    )
    .sort(
      (a, b) =>
        Math.max(Date.parse(b.modifiedAt ?? "") || 0, Date.parse(b.observedAt ?? "") || 0) -
        Math.max(Date.parse(a.modifiedAt ?? "") || 0, Date.parse(a.observedAt ?? "") || 0),
    );
  const candidates = {
    behind: context.sync.nodes
      .filter((node) => node.state === "behind")
      .map((node) => ({
        nodeId: node.nodeId,
        name: shorten(path.posix.basename(node.path), 56),
        reason: shorten(node.reasons.join("; "), 160),
      })),
    ahead: context.sync.nodes
      .filter((node) => node.state === "ahead")
      .map((node) => ({
        nodeId: node.nodeId,
        name: shorten(path.posix.basename(node.path), 56),
        ...(node.aheadSince
          ? {
              since: node.aheadSince,
              ageSeconds: Math.max(0, Math.floor((now - Date.parse(node.aheadSince)) / 1000)),
            }
          : { sinceUnknown: true }),
      })),
    recentInputs: files
      .filter((file) => file.kind !== "written")
      .slice(0, 10)
      .map((file) => ({ address: file.address, kind: file.kind, at: file.observedAt })),
    recentOutputs: files
      .filter((file) => file.kind === "written")
      .slice(0, 10)
      .map((file) => ({
        address: file.address,
        at: file.observedAt,
        versionKnown: file.versionKnown,
      })),
    unlinkedOutputs: recentUnlinked.map(({ sessionId: _sessionId, ...output }) => ({ ...output })),
    cardInputs: context.cards.items
      .filter((card) => !card.diagnostic && card.status !== "deprecated")
      .sort((a, b) => String(b.publishedAt ?? "").localeCompare(String(a.publishedAt ?? "")))
      .map((card) => ({
        cardId: String(card.cardId),
        title: shorten(String(card.title ?? card.cardId), 72),
        state: String(card.state),
      })),
  } satisfies Record<string, BriefItem[]>;
  const brief: ContextBrief = {
    counts: context.sync.counts,
    behind: [],
    ahead: [],
    recentInputs: [],
    recentOutputs: [],
    unlinkedOutputs: [],
    cardInputs: [],
    omitted: {},
    ...(context.observations.uncertain ? { observationUncertain: true } : {}),
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
  const lines = [
    `synced ${brief.counts.synced} · ahead ${brief.counts.ahead} · behind ${brief.counts.behind} · unanchored ${brief.counts.unanchored}`,
  ];
  const sections: [
    keyof Pick<
      ContextBrief,
      "behind" | "ahead" | "recentInputs" | "recentOutputs" | "unlinkedOutputs" | "cardInputs"
    >,
    string,
  ][] = [
    ["behind", "Behind"],
    ["ahead", "Ahead"],
    ["recentInputs", "Recent inputs"],
    ["recentOutputs", "Recent outputs"],
    ["unlinkedOutputs", "Recent unlinked outputs"],
    ["cardInputs", "Input Cards (reception does not mean completion)"],
  ];
  for (const [key, title] of sections) {
    if (!brief[key].length) continue;
    lines.push(title + ":");
    for (const item of brief[key]) {
      const identity = String(item.nodeId ?? item.cardId ?? item.address);
      const detail =
        key === "ahead"
          ? `${String(item.name ?? "")}; ${item.since ? `since ${item.since} (${formatAge(Number(item.ageSeconds))})` : "start time not recorded"}`
          : String(item.reason ?? item.title ?? item.kind ?? item.at ?? item.address ?? "");
      lines.push(
        `- ${identity}${detail && detail !== identity ? ` ${detail}` : ""}${item.state ? ` [${item.state}]` : ""}`,
      );
    }
  }
  const omitted = Object.values(brief.omitted).reduce((sum, n) => sum + n, 0);
  if (omitted)
    lines.push(
      `${omitted} items omitted; use node check, workspace drift or the referenced address.`,
    );
  if (brief.omitted.unlinkedOutputs)
    lines.push(
      `${brief.omitted.unlinkedOutputs} older or omitted unlinked outputs; use workspace drift for the full list.`,
    );
  if (brief.observationUncertain)
    lines.push("Session observations are incomplete; only evidenced addresses are shown.");
  if (brief.synchronizationUncertain)
    lines.push(
      "Some Nodes changed during inspection; synchronization and unlinked-output findings are incomplete. Retry workspace brief.",
    );
  if (brief.roleId)
    lines.push(`Card filter: ${brief.roleId}; synchronization counts cover the whole Workspace.`);
  return lines.join("\n");
}

function formatAge(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
