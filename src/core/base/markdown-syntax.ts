import { fromMarkdown } from "mdast-util-from-markdown";
import type { Definition, Link, Nodes, Root } from "mdast";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

function walk(node: Nodes, visit: (node: Nodes) => "skip" | void): void {
  if (visit(node) === "skip") return;
  if ("children" in node) for (const child of node.children) walk(child, visit);
}
function definitions(tree: Root): Map<string, Definition> {
  const result = new Map<string, Definition>();
  walk(tree, (node) => {
    if (node.type === "definition" && !result.has(node.identifier))
      result.set(node.identifier, node);
  });
  return result;
}
function labelText(node: Nodes): string {
  if ("value" in node) return node.value;
  return "children" in node ? node.children.map(labelText).join("") : "";
}
type Span = { start: number; end: number };
type MarkdownSyntax = {
  length: number;
  links: Array<{ url: string; label?: string; span?: Span }>;
  mentionExclusions: Span[];
  destinations: Array<{ url: string; span?: Span & { angled: boolean } }>;
  headings: Array<{ start: number; depth: number; text: string }>;
};
export type MarkdownSyntaxCache = Map<string, MarkdownSyntax>;
const syntaxCaches = new AsyncLocalStorage<{
  previous: MarkdownSyntaxCache;
  used: MarkdownSyntaxCache;
}>();

/** Only syntax is retained; Node identities and destination mappings stay live. */
export async function withMarkdownSyntaxCache<T>(
  previous: MarkdownSyntaxCache,
  action: () => Promise<T>,
) {
  const used: MarkdownSyntaxCache = new Map();
  const result = await syntaxCaches.run({ previous, used }, action);
  return { result, used };
}

export function validMarkdownSyntaxCache(value: unknown): value is MarkdownSyntaxCache {
  if (!(value instanceof Map)) return false;
  const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  for (const [key, entry] of value) {
    if (
      typeof key !== "string" ||
      !/^[a-f0-9]{64}$/.test(key) ||
      !record(entry) ||
      !Number.isSafeInteger(entry.length) ||
      (entry.length as number) < 0
    )
      return false;
    const span = (value: unknown) =>
      record(value) &&
      Number.isSafeInteger(value.start) &&
      Number.isSafeInteger(value.end) &&
      (value.start as number) >= 0 &&
      (value.start as number) <= (value.end as number) &&
      (value.end as number) <= (entry.length as number);
    if (
      !Array.isArray(entry.links) ||
      !entry.links.every(
        (link) =>
          record(link) &&
          typeof link.url === "string" &&
          (link.label === undefined || typeof link.label === "string") &&
          (link.span === undefined || span(link.span)),
      ) ||
      !Array.isArray(entry.mentionExclusions) ||
      !entry.mentionExclusions.every(span) ||
      !Array.isArray(entry.destinations) ||
      !entry.destinations.every(
        (destination) =>
          record(destination) &&
          typeof destination.url === "string" &&
          (destination.span === undefined ||
            (span(destination.span) &&
              typeof (destination.span as Record<string, unknown>).angled === "boolean")),
      ) ||
      !Array.isArray(entry.headings) ||
      !entry.headings.every(
        (heading) =>
          record(heading) &&
          Number.isSafeInteger(heading.start) &&
          (heading.start as number) >= 0 &&
          (heading.start as number) <= (entry.length as number) &&
          Number.isSafeInteger(heading.depth) &&
          (heading.depth as number) >= 1 &&
          (heading.depth as number) <= 6 &&
          typeof heading.text === "string",
      )
    )
      return false;
  }
  return true;
}

export function markdownSyntax(body: string): MarkdownSyntax {
  const cache = syntaxCaches.getStore();
  const key = cache ? createHash("sha256").update(body).digest("hex") : undefined;
  const retained = key ? (cache?.used.get(key) ?? cache?.previous.get(key)) : undefined;
  if (retained) {
    cache!.used.set(key!, retained);
    return retained;
  }
  const tree = fromMarkdown(body),
    defs = definitions(tree);
  const syntax: MarkdownSyntax = {
    length: body.length,
    links: [],
    mentionExclusions: [],
    destinations: [],
    headings: tree.children
      .filter((node) => node.type === "heading")
      .map((node) => ({
        start: node.position!.start.offset!,
        depth: node.depth,
        text: headingText(node).trim(),
      })),
  };
  walk(tree, (node) => {
    if (node.type === "image" || node.type === "imageReference") return "skip";
    if (node.type !== "link" && node.type !== "linkReference") return;
    const url = node.type === "link" ? node.url : defs.get(node.identifier)?.url;
    if (!url || url.startsWith("#")) return "skip";
    const start = node.position?.start.offset,
      end = node.position?.end.offset;
    syntax.links.push({
      url,
      label: labelText(node).replace(/\s+/g, " ").trim() || undefined,
      ...(start !== undefined && end !== undefined ? { span: { start, end } } : {}),
    });
    return "skip";
  });
  walk(tree, (node) => {
    if (!["link", "linkReference", "definition"].includes(node.type)) return;
    const start = node.position?.start.offset,
      end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) syntax.mentionExclusions.push({ start, end });
    return "skip";
  });
  const candidates = new Set<Link | Definition>();
  walk(tree, (node) => {
    if (node.type === "link") {
      candidates.add(node);
      return "skip";
    }
    if (node.type === "linkReference") {
      const definition = defs.get(node.identifier);
      if (definition) candidates.add(definition);
      return "skip";
    }
    if (node.type === "image" || node.type === "imageReference") return "skip";
  });
  syntax.destinations = [...candidates].map((node) => ({
    url: node.url,
    span: destinationSpan(body, node),
  }));
  if (cache) cache.used.set(key!, syntax);
  return syntax;
}

function headingText(node: Nodes): string {
  if ("value" in node) return node.value;
  if ("alt" in node) return node.alt ?? "";
  return "children" in node ? node.children.map(headingText).join("") : "";
}

/** Locate the URL within an AST-confirmed Markdown link/definition. */
function destinationSpan(body: string, node: Link | Definition) {
  const start = node.position?.start.offset,
    end = node.position?.end.offset;
  if (start === undefined || end === undefined) return;
  let cursor: number;
  if (node.type === "definition") {
    const prefix = /^\[(?:\\[\s\S]|[^\]\\])*\]:\s*/.exec(body.slice(start, end));
    if (!prefix) return;
    cursor = start + prefix[0].length;
  } else {
    const labelEnd = node.children.at(-1)?.position?.end.offset ?? start + 1;
    cursor = body.indexOf("](", labelEnd);
    if (cursor < labelEnd || cursor >= end) return;
    cursor += 2;
    while (cursor < end && /\s/.test(body[cursor]!)) cursor++;
  }
  const destinationStart = cursor,
    angled = body[cursor] === "<";
  if (angled) {
    cursor++;
    while (cursor < end) {
      if (body[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (body[cursor++] === ">") return { start: destinationStart, end: cursor, angled };
    }
    return;
  }
  let depth = 0;
  while (cursor < end) {
    const char = body[cursor]!;
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (/\s/.test(char) || (char === ")" && depth === 0)) break;
    if (char === "(") depth++;
    if (char === ")") depth--;
    cursor++;
  }
  return { start: destinationStart, end: cursor, angled };
}
