import { markdownSyntax } from "./markdown-syntax.js";

export class NodeSectionError extends Error {
  constructor(
    readonly code: "SECTION_NOT_FOUND" | "SECTION_AMBIGUOUS",
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
  const headings = markdownSyntax(body).headings;
  const matches = headings.filter((node) => node.text === heading);
  if (!matches.length) return undefined;
  if (matches.length !== 1)
    throw new NodeSectionError(
      "SECTION_AMBIGUOUS",
      `Markdown section heading is duplicated: ${heading}`,
      { heading, count: matches.length },
    );
  const selected = matches[0]!;
  const start = selected.start;
  const next = headings.find((node) => node.start > start && node.depth <= selected.depth);
  const end = next?.start ?? body.length;
  return { start, end, depth: selected.depth, text: body.slice(start, end) };
}
