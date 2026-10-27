import { briefLine, projectAgentContext, type AgentContextPage } from "./agent-context-page.js";
import { baselineOnlyBehind, type CurrentContext } from "./context-brief.js";
import type { AgentContext } from "./agent-context.js";

type Problem = { kind: string; line: string; nodeId?: string; cardId?: string; truncated?: true };
export type AgentBrief = {
  counts: { ahead: number; behind: number };
  workspaceIssues: { items: Problem[]; total: number; omitted: number };
  agentContext: AgentContextPage;
  roleId?: string;
};

/** Existing brief priority, bounded across all problem kinds rather than per old collection. */
export function projectAgentBrief(
  context: CurrentContext,
  facts: AgentContext,
  workspaceRoot: string,
): AgentBrief {
  const problems: Problem[] = [];
  const add = (
    kind: string,
    prefix: string,
    title: string,
    identity: { nodeId?: string; cardId?: string } = {},
  ) => problems.push({ kind, ...identity, ...briefLine(prefix, title) });
  for (const item of context.recoveryConflicts ?? []) add("recovery", "Recovery", item);
  if (context.draftCount)
    add("draft", "Draft", `${context.draftCount} unsettled Nodes; inspect the Node listing`);
  for (const item of context.sync.invalidNodes ?? [])
    add("invalid", item.nodeId ?? "Invalid", `${item.path}: ${item.reason}`, {
      nodeId: item.nodeId,
    });
  for (const item of context.sync.nodes.filter((node) => node.ahead))
    add("ahead", item.nodeId, `${item.path}: ${item.ahead!.reasons.join("; ")}`, {
      nodeId: item.nodeId,
    });
  for (const item of context.changedCardSources.items.filter((item) =>
    context.sync.nodes.some((node) => node.nodeId === item.nodeId && node.ahead),
  ))
    add(
      "changed-source",
      `${item.cardId} → ${item.nodeId}`,
      `${item.path ?? item.publishedVersion.path}: ${item.reason}`,
      { nodeId: item.nodeId, cardId: item.cardId },
    );
  let baselineOnly = 0;
  for (const item of context.sync.nodes.filter((node) => node.behind)) {
    if (baselineOnlyBehind(item)) {
      baselineOnly++;
      continue;
    }
    add("behind", item.nodeId, `${item.path}: ${item.behind!.reasons.join("; ")}`, {
      nodeId: item.nodeId,
    });
  }
  if (baselineOnly)
    add(
      "baseline",
      "Baseline",
      `${baselineOnly} behind Nodes lack retained baselines; inspect workspace drift`,
    );
  if (context.changedCardSources.diagnostics.length)
    add("uncertain-source", "Unknown", "Some received Card sources could not be compared");
  if (context.sync.nodes.some((node) => node.uncertain))
    add(
      "uncertain-sync",
      "Unknown",
      "Some Nodes changed during inspection; synchronization is incomplete",
    );
  const base = {
    counts: { ahead: context.sync.counts.ahead, behind: context.sync.counts.behind },
    workspaceIssues: {
      items: problems.slice(0, 10),
      total: problems.length,
      omitted: Math.max(0, problems.length - 10),
    },
    ...(facts.start.kind === "brief" && facts.start.roleId ? { roleId: facts.start.roleId } : {}),
  };
  const scopeReads = (page: AgentContextPage): AgentContextPage => ({
    ...page,
    readNotice: `${page.readNotice} Card rows show identity, state and title; reception/return details are in the Card reads below.`,
    sourceReads: [
      ...page.sourceReads,
      ...(base.counts.ahead || base.counts.behind
        ? [
            {
              title: "Ahead/behind details",
              command: `tent workspace drift --workspace '${workspaceRoot.replace(/'/g, process.platform === "win32" ? "''" : `'"'"'`)}'`,
            },
          ]
        : []),
    ],
  });
  const agentContext = projectAgentContext(
    facts,
    workspaceRoot,
    { text: "", bytes: 0 },
    (input) => {
      const page = scopeReads(input);
      return Math.max(
        Buffer.byteLength(JSON.stringify({ ...base, agentContext: page }) + "\n"),
        Buffer.byteLength(formatAgentBrief({ ...base, agentContext: page }) + "\n"),
      );
    },
  );
  return { ...base, agentContext: scopeReads(agentContext) };
}

export function formatAgentBrief(value: AgentBrief) {
  const early = new Set(["recovery", "draft", "invalid"]);
  const cards = value.agentContext.sections.find((section) => section.kind === "open")!;
  const nodes = value.agentContext.sections.find((section) => section.kind === "references")!;
  const unknown = value.agentContext.sections.find((section) => section.kind === "unknown")!;
  const rows = (section: typeof cards) =>
    section.items.map(
      (item) =>
        `- ${briefLine([item.nodeId ?? item.cardId, item.at ?? item.state].filter(Boolean).join(" "), item.title ?? item.why ?? "").line}`,
    );
  const more = (total: number) => (total ? [`${total} more; read with the commands below.`] : []);
  return [
    `behind ${value.counts.behind} · ahead ${value.counts.ahead}`,
    ...value.workspaceIssues.items
      .filter((item) => early.has(item.kind))
      .map((item) => `- ${item.line}`),
    "Input Cards",
    ...rows(cards),
    ...more(cards.omitted),
    ...value.workspaceIssues.items
      .filter((item) => !early.has(item.kind))
      .map((item) => `- ${item.line}`),
    ...more(value.workspaceIssues.omitted),
    "Recently changed Nodes",
    ...rows(nodes),
    ...more(nodes.omitted),
    ...unknown.items.map((item) => `- ${briefLine(item.nodeId ?? "", item.why ?? "").line}`),
    ...more(unknown.omitted),
    value.agentContext.readNotice,
    ...value.agentContext.sourceReads.map((read) => `${read.title}: ${read.command}`),
    ...(value.roleId
      ? [`Card filter: ${value.roleId}; workspace problem counts remain workspace-wide.`]
      : []),
  ].join("\n");
}
