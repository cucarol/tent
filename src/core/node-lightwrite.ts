import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";
import { withTentMutation, type FsAdapter } from "./adapter.js";
import { contentEtag } from "./etag.js";
import { canonicalDocumentReferences } from "./document-links.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { nodeNotePath } from "./paths.js";
import { readNodeForEdit } from "./node-query.js";
import {
  NodeWriteError,
  prepareNodeDocumentWrite,
  savePreparedNodeDocumentUnlocked,
} from "./node-document-write.js";

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

export type NodeAppendInput = { body: string; heading?: string; by?: string };
export type NodeSectionWriteInput = {
  heading: string;
  baseEtag: string;
  body: string;
  by?: string;
};

type Section = { start: number; end: number; depth: number; text: string };

/** Append without a caller read; the current body is observed only inside the write lock. */
export function appendNodeBody(fs: FsAdapter, nodeId: string, input: NodeAppendInput) {
  assertBody(input.body);
  const heading = input.heading === undefined ? undefined : headingText(input.heading);
  if (!input.body.trim() && heading === undefined)
    throw new NodeWriteError("INVALID_INPUT", "node.append requires nonempty Markdown or heading");
  return withTentMutation(
    fs,
    async () => {
      const current = await readNodeForEdit(fs, nodeId);
      const eol = /\r?\n/.exec(current.raw)?.[0] ?? "\n";
      const section = heading === undefined ? undefined : findSection(current.body, heading);
      const addition = normalizeTail(
        (heading === undefined || section ? "" : `## ${escapeHeading(heading)}${eol}${eol}`) +
          input.body.replace(/\r?\n/g, eol).replace(/^(?:[ \t]*\r?\n)+/, ""),
      );
      const end = section?.end ?? current.body.length;
      const existing = normalizeTail(current.body.slice(0, end));
      const prefix = existing ? existing + eol + eol : "";
      const remainder = current.body.slice(end);
      const body = await resolveChangedBody(
        fs,
        current.path,
        current.raw,
        prefix + addition + eol + (remainder ? eol + remainder : ""),
        {
          start: prefix.length,
          end: prefix.length + addition.length,
        },
      );
      return saveBody(fs, current, body, "node.append", input.by);
    },
    { operation: "node.append" },
  );
}

/** Read the complete selected section, including its heading and nested subsections. */
export async function readNodeSection(fs: FsAdapter, nodeId: string, heading: string) {
  const title = headingText(heading);
  const current = await readNodeForEdit(fs, nodeId);
  const section = selectSection(current.body, title);
  return {
    nodeId,
    path: current.path,
    heading: title,
    depth: section.depth,
    text: section.text,
    sectionEtag: sectionEtag(nodeId, title, section.text),
  };
}

/** Replace the exact section range; only that section's observed bytes are the CAS basis. */
export function writeNodeSection(fs: FsAdapter, nodeId: string, input: NodeSectionWriteInput) {
  const title = headingText(input.heading);
  assertBody(input.body);
  if (typeof input.baseEtag !== "string" || !input.baseEtag.trim())
    throw new NodeWriteError("ETAG_REQUIRED", "node.write-section requires a section ETag");
  return withTentMutation(
    fs,
    async () => {
      const current = await readNodeForEdit(fs, nodeId);
      const section = selectSection(current.body, title);
      const currentEtag = sectionEtag(nodeId, title, section.text);
      if (input.baseEtag !== currentEtag)
        throw new NodeSectionError(
          "SECTION_ETAG_CONFLICT",
          "Section ETag conflict; reread the section",
          {
            nodeId,
            heading: title,
            baseEtag: input.baseEtag,
            currentSectionEtag: currentEtag,
          },
        );
      let replacement = input.body;
      const remainder = current.body.slice(section.end);
      // The separator belongs to the replaced range; keep the following heading on its own block.
      if (remainder && replacement && !/\r?\n[ \t]*\r?\n$/.test(replacement)) {
        const eol = /\r?\n/.exec(current.raw)?.[0] ?? "\n";
        replacement = normalizeTail(replacement) + eol + eol;
      }
      const body = await resolveChangedBody(
        fs,
        current.path,
        current.raw,
        current.body.slice(0, section.start) + replacement + remainder,
        { start: section.start, end: section.start + replacement.length },
      );
      return saveBody(fs, current, body, "node.write-section", input.by);
    },
    { operation: "node.write-section" },
  );
}

async function resolveChangedBody(
  fs: FsAdapter,
  nodePath: string,
  raw: string,
  body: string,
  range: { start: number; end: number },
) {
  const parsed = parseFrontmatter(raw);
  return canonicalDocumentReferences(fs, nodeNotePath(nodePath), parsed.data, body, range);
}

async function saveBody(
  fs: FsAdapter,
  current: Awaited<ReturnType<typeof readNodeForEdit>>,
  body: string,
  operation: string,
  by?: string,
) {
  const node = { id: current.nodeId, path: current.path, name: current.name };
  const input = { baseEtag: current.etag, body, by };
  const prepared = prepareNodeDocumentWrite(node, current.raw, input);
  const parsed = parseFrontmatter(prepared);
  // Canonicalize material addresses without rewriting Markdown outside the changed range.
  await canonicalDocumentReferences(fs, nodeNotePath(current.path), parsed.data, "");
  return savePreparedNodeDocumentUnlocked(
    fs,
    node,
    current.raw,
    serializeFrontmatter(parsed.data, parsed.body, parsed.keyOrder),
    input,
    operation,
  );
}

function selectSection(body: string, heading: string): Section {
  const section = findSection(body, heading);
  if (!section)
    throw new NodeSectionError("SECTION_NOT_FOUND", `Markdown section not found: ${heading}`, {
      heading,
    });
  return section;
}

function findSection(body: string, heading: string): Section | undefined {
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

function sectionEtag(nodeId: string, heading: string, text: string) {
  return "section:" + contentEtag(JSON.stringify([nodeId, heading, text]));
}

function headingText(value: string): string {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value))
    throw new NodeWriteError("INVALID_INPUT", "heading must be nonempty single-line text");
  return value.trim();
}

function assertBody(value: string): void {
  if (typeof value !== "string")
    throw new NodeWriteError("INVALID_INPUT", "body must be Markdown text");
}

function normalizeTail(value: string): string {
  return value.replace(/(?:\r?\n[ \t]*)+$/, "");
}

function escapeHeading(value: string): string {
  return value.replace(/[\\`*{}\[\]()#+.!_<>&]/g, "\\$&");
}
