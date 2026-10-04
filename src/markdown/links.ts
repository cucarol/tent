import { fromMarkdown } from "mdast-util-from-markdown";
import type { Definition, Link, Nodes, Root } from "mdast";
import { resolveNode, type OkfNode } from "../core/okf-index.js";
import { normalizeTarget } from "../core/link-target.js";
import { ATTACHMENTS_DIR } from "../core/paths.js";

export { normalizeTarget } from "../core/link-target.js";
export type OutLink = {
  raw: string;
  kind: "md" | "artifact";
  targetNodeId?: string;
  targetPath?: string;
  label?: string;
};
export type ExtractedOutLink = OutLink & {
  range?: { unit: "utf16"; start: number; end: number };
  fragment?: string;
};
export type ResolvedLink = Omit<OutLink, "kind"> & { kind: OutLink["kind"] | "unresolved" };

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
function external(href: string): boolean {
  return href.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(href);
}
function pathPart(href: string): string {
  return href.split(/[?#]/, 1)[0]!;
}
function attachment(href: string): boolean {
  return href.replace(/\\/g, "/").split("/").includes(ATTACHMENTS_DIR);
}

/** Standard Markdown links only. Code, HTML, images and wiki text are not edges. */
export function extractOutLinksDetailed(body: string, occurrences = false): ExtractedOutLink[] {
  const tree = fromMarkdown(body),
    defs = definitions(tree);
  const out: ExtractedOutLink[] = [],
    seen = new Set<string>();
  walk(tree, (node) => {
    if (node.type === "image" || node.type === "imageReference") return "skip";
    if (node.type !== "link" && node.type !== "linkReference") return;
    const url = node.type === "link" ? node.url : defs.get(node.identifier)?.url;
    if (!url || url.startsWith("#")) return "skip";
    const targetPath = pathPart(url);
    if (!external(url) && attachment(targetPath)) return "skip";
    const label = labelText(node).replace(/\s+/g, " ").trim() || undefined;
    const key = JSON.stringify([url, label]);
    if (!occurrences && seen.has(key)) return "skip";
    seen.add(key);
    const start = node.position?.start.offset,
      end = node.position?.end.offset;
    out.push({
      raw: url,
      kind: external(url) ? "artifact" : "md",
      targetPath,
      label,
      ...(url.includes("#") ? { fragment: url.slice(url.indexOf("#") + 1) } : {}),
      ...(occurrences && start !== undefined && end !== undefined
        ? { range: { unit: "utf16", start, end } }
        : {}),
    });
    return "skip";
  });
  return out;
}
export function resolveOutLink(
  index: Map<string, OkfNode[]>,
  link: OutLink,
  fromNotePath?: string,
): ResolvedLink {
  if (link.kind === "artifact") return { raw: link.raw, kind: "artifact", label: link.label };
  const target = link.targetPath ?? pathPart(link.raw);
  if (!target || target.startsWith("#") || external(target) || attachment(target)) {
    return { raw: link.raw, kind: "unresolved", label: link.label };
  }
  const normalized = normalizeTarget(target, fromNotePath);
  if (normalized === ".." || normalized.startsWith("../")) {
    return { raw: link.raw, kind: "unresolved", label: link.label };
  }
  const resolved = resolveNode(index, normalized);
  if (!resolved) return { raw: link.raw, kind: "unresolved", label: link.label };
  return {
    raw: link.raw,
    kind: "md",
    targetNodeId: resolved.nodeId,
    targetPath: resolved.path,
    label: link.label ?? resolved.name,
  };
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

/** Parse full-document references; an edit range limits which destination bytes may change. */
export function rewriteMarkdownDestinations(
  body: string,
  map: (url: string) => string | undefined,
  range?: { start: number; end: number },
): string {
  const tree = fromMarkdown(body),
    defs = definitions(tree);
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
  const edits: { start: number; end: number; value: string }[] = [];
  for (const node of candidates) {
    const mapped = map(node.url);
    if (mapped === undefined || mapped === node.url) continue;
    const span = destinationSpan(body, node);
    if (!span) throw new Error("Cannot locate Markdown link destination");
    if (range && (span.start < range.start || span.end > range.end)) continue;
    const escaped = mapped.replace(/\\/g, "\\\\").replace(/[<>]/g, (char) => "\\" + char);
    const value = span.angled
      ? "<" + escaped + ">"
      : escaped.replace(/\s/g, encodeURIComponent).replace(/[()]/g, (char) => "\\" + char);
    edits.push({ ...span, value });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    body = body.slice(0, edit.start) + edit.value + body.slice(edit.end);
  }
  return body;
}
