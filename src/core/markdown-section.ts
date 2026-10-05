import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";

export class NodeSectionError extends Error {
  constructor(
    readonly code: "SECTION_NOT_FOUND" | "SECTION_AMBIGUOUS" | "SECTION_ETAG_CONFLICT",
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "NodeSectionError";
  }
}

export type MarkdownSection = { start: number; end: number; depth: number; text: string };

/** Select the heading and its descendants up to the next peer or ancestor heading. */
export function selectSection(body: string, heading: string): MarkdownSection {
  const section = findSection(body, heading);
  if (!section)
    throw new NodeSectionError("SECTION_NOT_FOUND", `Markdown section not found: ${heading}`, {
      heading,
    });
  return section;
}

export function findSection(body: string, heading: string): MarkdownSection | undefined {
  const headings = fromMarkdown(body).children.filter((node) => node.type === "heading");
  const matches = headings.filter((node) => inlineText(node).trim() === heading);
  if (!matches.length) return undefined;
  if (matches.length !== 1)
    throw new NodeSectionError(
      "SECTION_AMBIGUOUS",
      `Markdown section heading is duplicated: ${heading}`,
      { heading, count: matches.length },
    );
  const selected = matches[0]!;
  const start = selected.position!.start.offset!;
  const next = headings.find(
    (node) => node.position!.start.offset! > start && node.depth <= selected.depth,
  );
  const end = next?.position!.start.offset ?? body.length;
  return { start, end, depth: selected.depth, text: body.slice(start, end) };
}

function inlineText(node: Nodes): string {
  if ("value" in node) return node.value;
  if ("alt" in node) return node.alt ?? "";
  return "children" in node ? node.children.map(inlineText).join("") : "";
}
