import type { AgentContext, AgentContextItem } from "./agent-context.js";

const pageBytes = 16 * 1024;
export const originalContextBytes = pageBytes / 2;

/** Code point limits never split a surrogate pair or CRLF. Source bytes are not rewritten. */
export function contextExcerpt(text: string, maximum: number) {
  const characters = Array.from(text);
  let value = characters.slice(0, maximum).join("");
  if (value.endsWith("\r") && characters[maximum] === "\n") value = value.slice(0, -1);
  return { text: value, ...(value.length < text.length ? { truncated: true as const } : {}) };
}

/** A displayed brief item includes its bullet within 120 code points. Identity is never cut. */
export function briefLine(prefix: string, title: string) {
  const normalized = title.replace(/[\r\n\t]/g, " ");
  const remaining = 118 - Array.from(prefix).length - (prefix && normalized ? 1 : 0);
  if (remaining < 0)
    throw new Error("PAGE_TOO_LARGE: brief identity cannot fit a 120-character line");
  const shortened = contextExcerpt(normalized, remaining);
  const detail = shortened.truncated
    ? contextExcerpt(normalized, Math.max(0, remaining - 1)).text + (remaining ? "…" : "")
    : shortened.text;
  return {
    line: [prefix, detail].filter(Boolean).join(" "),
    ...(shortened.truncated || normalized !== title ? { truncated: true as const } : {}),
  };
}

type PageItem = Omit<AgentContextItem, "why"> & {
  why?: string;
  textInBody?: true;
  textOmitted?: true;
  detailsOmitted?: true;
};
export type AgentContextPage = {
  revision: string;
  sections: {
    kind: AgentContext["sections"][number]["kind"];
    items: PageItem[];
    total: number;
    omitted: number;
    display?: "titles" | "omitted";
  }[];
  sourceReads: { title: string; command?: string }[];
  readNotice: string;
};
const quote = (text: string) =>
  process.platform === "win32"
    ? `'${text.replace(/'/g, "''")}'`
    : `'${text.replace(/'/g, `'"'"'`)}'`;

/** Projection only: the complete Core evidence and its revision-bound API pages remain intact. */
export function projectAgentContext(
  context: AgentContext,
  workspaceRoot: string,
  primary: { text: string; bytes: number; nodeId?: string; cardId?: string },
  measure: (page: AgentContextPage) => number,
): AgentContextPage {
  const workspace = ` --workspace ${quote(workspaceRoot)}`;
  const brief = context.start.kind === "brief";
  const sourceReads: AgentContextPage["sourceReads"] = [];
  if (context.start.kind === "card")
    sourceReads.push({
      title: "Current raw Card and source addresses; inspect diagnostics",
      command: `tent card show ${context.start.cardId} --view raw${workspace}`,
    });
  if (context.start.kind === "brief") {
    const role = context.start.roleId ? ` --role ${context.start.roleId} --include-open` : "";
    for (const state of ["pending", "returned", "consumed"])
      sourceReads.push({
        title: `${state} Cards${state === "consumed" ? "; includes completed Cards" : ""}`,
        command: `tent card list --state ${state}${role} --json${workspace}`,
      });
    sourceReads.push(
      {
        title: "All Nodes; broader than recent changes",
        command: `tent node list --full --json${workspace}`,
      },
      { title: "Workspace problems", command: `tent workspace check --json${workspace}` },
    );
  }
  const sections = context.sections.map((section) => ({
    kind: section.kind,
    total: section.total,
    omitted: section.omitted,
    items: section.items.map((item): PageItem => {
      const why = contextExcerpt(item.why, 120);
      const title = item.title ? contextExcerpt(item.title, 120) : undefined;
      if (section.kind === "unknown")
        return {
          why: brief
            ? briefLine(item.nodeId ?? "", item.why).line.slice(
                item.nodeId ? item.nodeId.length + 1 : 0,
              )
            : why.text,
          ...(why.truncated || (brief && briefLine(item.nodeId ?? "", item.why).truncated)
            ? { truncated: true }
            : {}),
          ...(item.nodeId ? { nodeId: item.nodeId } : {}),
        };
      if (brief && ["references", "open"].includes(section.kind)) {
        const prefix = [item.nodeId ?? item.cardId, item.at ?? item.state]
          .filter(Boolean)
          .join(" ");
        const title = briefLine(prefix, item.title ?? "");
        return {
          ...(item.nodeId ? { nodeId: item.nodeId } : {}),
          ...(item.cardId ? { cardId: item.cardId } : {}),
          ...(item.at ? { at: item.at } : {}),
          ...(item.state ? { state: item.state } : {}),
          title: title.line.slice(prefix.length + (item.title ? 1 : 0)),
          why: why.text,
          ...(title.truncated || why.truncated ? { truncated: true } : {}),
        };
      }
      const output: PageItem = {
        ...item,
        why: why.text,
        ...(title ? { title: title.text } : {}),
        ...(why.truncated || title?.truncated ? { truncated: true } : {}),
      };
      if (section.kind === "references") {
        if (item.nodeId) {
          output.command = `tent node get ${item.nodeId} --full${workspace}`;
          if (!sourceReads.some((read) => read.command === output.command))
            sourceReads.push({ title: item.nodeId, command: output.command });
        }
        if (
          (primary.nodeId && item.nodeId === primary.nodeId) ||
          (primary.cardId && item.cardId === primary.cardId)
        ) {
          delete output.text;
          output.textInBody = true;
        } else if (item.text !== undefined) {
          const limit = contextExcerpt(item.text, 1600);
          output.text = limit.text;
          if (limit.truncated) output.truncated = true;
        }
      } else if (item.text !== undefined) {
        const text = contextExcerpt(item.text, section.kind === "changes" ? 1600 : 120);
        output.text = text.text;
        if (text.truncated) output.truncated = true;
      }
      return output;
    }),
  }));
  // Original text, its addresses and source labels share the same half-page.
  // Reserve exact source identities before spending the remaining space on excerpts.
  const references = sections.find((section) => section.kind === "references")!;
  const full = references.items;
  const size = (item: PageItem) => Buffer.byteLength(JSON.stringify(item));
  const bounded = full.map((item): PageItem => ({
    ...(item.nodeId ? { nodeId: item.nodeId } : {}),
    ...(item.cardId ? { cardId: item.cardId } : {}),
    ...(item.version ? { version: item.version } : {}),
    ...(item.heading ? { heading: item.heading } : {}),
    ...(item.title ? { title: item.title } : {}),
    ...(item.at ? { at: item.at } : {}),
    why: contextExcerpt(item.why ?? "Task source", 40).text,
    ...(item.textInBody ? { textInBody: true } : item.text ? { textOmitted: true } : {}),
    detailsOmitted: true,
    truncated: true,
  }));
  let originals = primary.bytes + bounded.reduce((total, item) => total + size(item), 0);
  for (const item of [...bounded].reverse()) {
    if (originals <= originalContextBytes) break;
    const before = size(item);
    const characters = Array.from(item.title ?? "");
    let low = 0,
      high = characters.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      item.title = contextExcerpt(characters.join(""), middle).text;
      if (originals - before + size(item) <= originalContextBytes) low = middle;
      else high = middle - 1;
    }
    item.title = contextExcerpt(characters.join(""), low).text;
    originals += size(item) - before;
  }
  while (originals > originalContextBytes && bounded.length) originals -= size(bounded.pop()!);
  if (originals > originalContextBytes)
    throw new Error("PAGE_TOO_LARGE: original source addresses exceed their half-page");
  references.omitted = references.total - bounded.length;
  for (const [index, item] of full.slice(0, bounded.length).entries()) {
    const before = size(bounded[index]!);
    const candidate = (text: string | undefined): PageItem => ({
      ...item,
      ...(item.text
        ? text
          ? { text, ...(text !== item.text ? { truncated: true } : {}) }
          : { text: undefined, textOmitted: true, truncated: true }
        : {}),
    });
    if (
      originals - before + size(candidate(item.text === undefined ? undefined : "")) >
      originalContextBytes
    )
      continue;
    const characters = Array.from(item.text ?? "");
    let low = 0,
      high = characters.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (
        originals - before + size(candidate(contextExcerpt(characters.join(""), middle).text)) <=
        originalContextBytes
      )
        low = middle;
      else high = middle - 1;
    }
    bounded[index] = candidate(
      item.text === undefined ? undefined : contextExcerpt(characters.join(""), low).text,
    );
    originals += size(bounded[index]!) - before;
  }
  references.items = bounded;
  if (!sourceReads.length && context.start.kind === "resource")
    sourceReads.push({ title: `File ${context.start.resource}; use your own file reader` });
  const result: AgentContextPage = {
    revision: context.revision,
    sections,
    sourceReads: sourceReads.slice(0, 10),
    readNotice: brief
      ? "Times prove retained changes, not sessions. Node listing is broader; inspect each Node's history for retained changes."
      : "Source commands read bodies only, not the exact computed union. No CLI command lists all omitted assembled entries; use your own tools for those. Node reads are current and broader than a selected section; changes are in section 5. File sources use your own reader. Card raw lists all source addresses and versions.",
  };
  if (brief) {
    for (const kind of ["references", "open"]) {
      const section = result.sections.find((section) => section.kind === kind)!;
      while (measure(result) > pageBytes && section.items.length) {
        section.items.pop();
        section.omitted = section.total - section.items.length;
      }
    }
    if (measure(result) > pageBytes)
      throw new Error("PAGE_TOO_LARGE: brief metadata exceeds CLI page budget");
    return result;
  }
  const unknown = result.sections.find((section) => section.kind === "unknown")!;
  const originalUnknown = { items: unknown.items, total: unknown.total };
  const related =
    context.start.kind === "node"
      ? context.start.nodeId
      : context.start.kind === "resource"
        ? context.start.resource
        : context.start.kind === "card"
          ? `sources of ${context.start.cardId}: ${[...new Set(context.sections.find((section) => section.kind === "references")!.items.flatMap((item) => (item.nodeId ? [item.nodeId] : [])))].join(", ")}`
          : "the opening workspace";
  const fits = () => {
    const omissions = result.sections
      .filter((section) => !["references", "unknown"].includes(section.kind) && section.omitted)
      .map((section): PageItem => {
        const why = contextExcerpt(
          `${section.omitted} ${section.kind} omitted; no CLI lists all. Use your own tools for ${related}.`,
          120,
        );
        return {
          why: why.text,
          ...(why.truncated ? { truncated: true } : {}),
          ...(context.start.kind === "node" ? { nodeId: context.start.nodeId } : {}),
          ...(context.start.kind === "resource" ? { path: context.start.resource } : {}),
          ...(context.start.kind === "card" ? { cardId: context.start.cardId } : {}),
        };
      });
    unknown.items = [...omissions, ...originalUnknown.items].slice(0, 10);
    unknown.total = originalUnknown.total + omissions.length;
    unknown.omitted = unknown.total - unknown.items.length;
    return measure(result) <= pageBytes;
  };
  // Later optional categories yield first. References and unknown retain their own limits.
  for (const section of [...result.sections].reverse()) {
    if (fits()) return result;
    if (["references", "unknown"].includes(section.kind)) continue;
    section.items = section.items.map((item) => ({
      title: item.title ?? item.path ?? item.nodeId ?? item.cardId ?? "Evidence",
    }));
    section.display = "titles";
    if (fits()) return result;
    section.omitted = section.total;
    section.items = [];
    section.display = "omitted";
  }
  if (!fits())
    throw new Error(
      "PAGE_TOO_LARGE: bounded original context and unknown exceed CLI metadata budget",
    );
  return result;
}

export function formatAgentContextPage(context: AgentContextPage) {
  return [
    "Agent context",
    ...context.sections.flatMap((section) => [
      `${section.kind} (${section.total})${section.display ? ` [${section.display}]` : ""}`,
      ...section.items.map((item) =>
        [
          `- ${[item.nodeId ?? item.cardId, item.title, item.path].filter(Boolean).join(" ") || "Evidence"}${item.why ? `: ${item.why}` : ""}`,
          item.at ? `  Changed: ${item.at}` : "",
          item.heading ? `  Section: ${item.heading}` : "",
          item.version ? `  Version: ${JSON.stringify(item.version)}` : "",
          item.text ?? "",
          item.textInBody ? "  Original text is above." : "",
          item.textOmitted ? "  Excerpt omitted; read source below." : "",
          item.detailsOmitted ? "  Source details omitted; read source below." : "",
          item.truncated ? "  Truncated excerpt/display; read source below." : "",
        ]
          .filter(Boolean)
          .join("\n"),
      ),
      ...(section.omitted
        ? [
            section.kind === "references"
              ? `${section.omitted} source entries omitted; ${context.sourceReads.some((read) => read.command?.includes("card show") && read.command.includes("--view raw")) ? "Card raw below lists all source addresses and versions." : "inspect the source reads below."}`
              : section.kind === "unknown"
                ? `${section.omitted} further unknowns omitted.`
                : `${section.omitted} ${section.kind} entries omitted; no CLI lists this complete assembled list. Use your own tools.`,
          ]
        : []),
    ]),
    context.readNotice,
    ...context.sourceReads.map((read) => `${read.title}${read.command ? `: ${read.command}` : ""}`),
  ].join("\n");
}
