import { markdownSyntax } from "./markdown-syntax.js";
import { resolveNode, type OkfNode } from "./okf-index.js";
import { normalizeTarget } from "./link-target.js";

export { normalizeTarget } from "./link-target.js";
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

function external(href: string): boolean {
  return href.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(href);
}
function pathPart(href: string): string {
  return href.split(/[?#]/, 1)[0]!;
}

/** Standard Markdown links only. Code, HTML, images and wiki text are not edges. */
export function extractOutLinksDetailed(body: string, occurrences = false): ExtractedOutLink[] {
  const out: ExtractedOutLink[] = [],
    seen = new Set<string>();
  for (const { url, label, span } of markdownSyntax(body).links) {
    const targetPath = pathPart(url);
    const key = JSON.stringify([url, label]);
    if (!occurrences && seen.has(key)) continue;
    seen.add(key);
    out.push({
      raw: url,
      kind: external(url) ? "artifact" : "md",
      targetPath,
      label,
      ...(url.includes("#") ? { fragment: url.slice(url.indexOf("#") + 1) } : {}),
      ...(occurrences && span ? { range: { unit: "utf16", ...span } } : {}),
    });
  }
  return out;
}
export function resolveOutLink(
  index: Map<string, OkfNode[]>,
  link: OutLink,
  fromNotePath?: string,
): ResolvedLink {
  if (link.kind === "artifact") return { raw: link.raw, kind: "artifact", label: link.label };
  const target = link.targetPath ?? pathPart(link.raw);
  if (!target || target.startsWith("#") || external(target)) {
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

/** Parse full-document references; an edit range limits which destination bytes may change. */
export function rewriteMarkdownDestinations(
  body: string,
  map: (url: string) => string | undefined,
  range?: { start: number; end: number },
): string {
  if (!body.includes("[") && !body.includes("<")) return body;
  const edits: { start: number; end: number; value: string }[] = [];
  for (const { url, span } of markdownSyntax(body).destinations) {
    const mapped = map(url);
    if (mapped === undefined || mapped === url) continue;
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
