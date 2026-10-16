import { findSection } from "../base/markdown-section.js";
import { withTentMutation, type FsAdapter } from "../store/adapter.js";
import { canonicalDocumentReferences } from "../graph/document-links.js";
import { parseFrontmatter, serializeFrontmatter } from "../base/frontmatter.js";
import { nodeNotePath } from "../base/paths.js";
import { readNodeForEdit } from "../read/node-query.js";
import {
  NodeWriteError,
  prepareNodeDocumentWrite,
  savePreparedNodeDocumentUnlocked,
} from "../graph/node-document-write.js";

export type NodeAppendInput = { body: string; heading?: string; by?: string };
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
