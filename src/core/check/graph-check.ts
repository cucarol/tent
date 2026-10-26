import type { FsAdapter } from "../store/adapter.js";
import path from "node:path";
import { readOnlyFs } from "../store/adapter.js";
import { loadTent } from "../store/tree.js";
import { buildNodeIndex } from "../base/okf-index.js";
import { resolveOutLink, rewriteMarkdownDestinations } from "../base/links.js";
import { resolveTargetPath } from "../base/link-target.js";
import { parseFrontmatter } from "../base/frontmatter.js";
import { parseRoleDocument } from "../store/role-document.js";
import {
  completedCardPaths,
  parseCardDocument,
  verifyCardSourceVersions,
} from "../graph/card-document.js";
import {
  materialLocator,
  localMaterialPath,
  resourceSchema,
  isDirectoryMaterial,
  isPrefixMaterial,
  type MaterialSource,
} from "../base/material.js";
import { CARDS_DIR, ROLES_DIR, ORDER_PATH, nodeNotePath } from "../base/paths.js";
import { isNodeId, isRoleId, isCardId } from "../base/id.js";
import { markdownMaterialHeading } from "../base/material-section.js";
import { NodeSectionError } from "../base/markdown-section.js";
import { isHistoryDocument } from "../store/document-history.js";
import { assertSystemMaterial } from "../graph/material-target.js";

export type GraphCheckIssue =
  | { kind: "unresolved-link"; path: string; target: string; reason: string }
  | { kind: "node-git-mismatch"; path: string; state: "disk-only" | "git-only"; reason: string }
  | {
      kind:
        | "invalid-material-address"
        | "missing-material-file"
        | "missing-material-section"
        | "unanchored-material-file";
      path: string;
      field: "resource" | "sources";
      index?: number;
      resource?: string;
      suggestion?: string;
      reason: string;
    };

export type GraphCheckResult = {
  documents: number;
  issues: GraphCheckIssue[];
  notices: { path: string; field?: string; resource?: string; reason: string }[];
  errors: { path: string; reason: string }[];
};

/** Host inspection is injected; declarations with a slash require directories. */
export type GraphFileExists = (absolutePath: string, directory?: boolean) => Promise<boolean>;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Observe current Node, Role and Card references without repair, capture or reception. */
export async function checkGraph(
  fs: FsAdapter,
  workspaceRoot: string,
  fileExists: GraphFileExists,
): Promise<GraphCheckResult> {
  const readonlyFs = readOnlyFs(fs);
  const result: GraphCheckResult = { documents: 0, issues: [], notices: [], errors: [] };
  const documents: Array<{
    path: string;
    data: Record<string, unknown>;
    body: string;
    valid: boolean;
    id?: string;
  }> = [];
  const error = (path: string, reason: string) => {
    if (!result.errors.some((item) => item.path === path && item.reason === reason))
      result.errors.push({ path, reason });
  };
  const failedReads = new Map<string, string>();
  // Native hierarchy and identity rules still apply. An unreadable area is a
  // diagnostic, while sibling discovery continues without repair writes.
  const observationFs = new Proxy(readonlyFs, {
    get(target, key) {
      if (key === "readFile")
        return async (path: string) => {
          try {
            return await target.readFile(path);
          } catch (cause) {
            const reason = message(cause);
            failedReads.set(path, reason);
            error(path, reason);
            return path === ORDER_PATH ? "{}" : "";
          }
        };
      if (key === "listDir" || key === "exists")
        return async (path: string) => {
          try {
            return await target[key](path);
          } catch (cause) {
            error(path || ".", message(cause));
            return key === "listDir" ? [] : false;
          }
        };
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const tent = await loadTent(observationFs);
  const retainedPaths = await readonlyFs.retainedDocumentPaths?.();
  if (retainedPaths) {
    // Presence only: content edits are ordinary dirty files, captured by explicit reads.
    const isNodeDocument = (file: string) =>
      isHistoryDocument(file) &&
      !file.startsWith(`${ROLES_DIR}/`) &&
      !file.startsWith(`${CARDS_DIR}/`);
    const retained = new Set(retainedPaths.filter(isNodeDocument));
    const disk = new Set([...tent.byPath.keys()].map(nodeNotePath).filter(isNodeDocument));
    for (const file of disk)
      if (!retained.has(file))
        result.issues.push({
          kind: "node-git-mismatch",
          path: file,
          state: "disk-only",
          reason: "Node document exists on disk but not in Tent Git HEAD",
        });
    for (const file of retained)
      if (!disk.has(file))
        result.issues.push({
          kind: "node-git-mismatch",
          path: file,
          state: "git-only",
          reason: "Tent Git HEAD records this Node document but it is missing on disk",
        });
  }
  const index = buildNodeIndex([...tent.byPath.values()].filter((node) => !node.invalid));
  async function readDocument(path: string, validate: (raw: string) => void, valid = true) {
    result.documents++;
    let raw: string;
    try {
      raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        await readonlyFs.readBinary(path),
      );
    } catch (cause) {
      error(path, message(cause));
      return;
    }
    try {
      validate(raw);
    } catch (cause) {
      valid = false;
      error(path, message(cause));
    }
    try {
      const parsed = parseFrontmatter(raw);
      documents.push({
        path,
        data: parsed.data,
        body: parsed.body,
        valid,
        ...(typeof parsed.data.id === "string" ? { id: parsed.data.id } : {}),
      });
    } catch (cause) {
      error(path, message(cause));
    }
  }
  for (const node of tent.byPath.values()) {
    const file = nodeNotePath(node.path);
    if (node.invalid && !failedReads.has(file)) {
      const unavailableAncestor = node.invalidRootPath
        ? failedReads.get(nodeNotePath(node.invalidRootPath))
        : undefined;
      error(file, unavailableAncestor ?? node.invalidReason ?? "Invalid Node document");
    }
    await readDocument(file, () => {}, !node.invalid);
  }
  const completed = await completedCardPaths(readonlyFs);
  const completedDocuments: Array<{ path: string; raw: string }> = [];
  const foundCards = new Set<string>();
  for (const [directory, kind] of [
    [ROLES_DIR, "role"],
    [CARDS_DIR, "card"],
  ] as const) {
    if (!(await observationFs.exists(directory))) continue;
    for (const entry of await observationFs.listDir(directory)) {
      if (entry.isDir || !entry.name.endsWith(".md")) continue;
      const id = entry.name.slice(0, -3);
      const file = `${directory}/${entry.name}`;
      if (kind === "card") foundCards.add(file);
      await readDocument(`${directory}/${entry.name}`, (raw) => {
        if (kind === "role") parseRoleDocument(id, raw);
        else {
          parseCardDocument(id, raw);
          if (completed.has(file)) completedDocuments.push({ path: file, raw });
        }
      });
    }
  }
  for (const file of completed)
    if (!foundCards.has(file))
      error(file, "Completed Card retained in Tent Git is missing on disk");
  if (completedDocuments.length && readonlyFs.history)
    for (const changed of await readonlyFs.history.changedRetainedDocuments(completedDocuments))
      error(changed.path, "Completed Card differs from its retained Tent Git version");
  const byPath = new Map(documents.map((document) => [document.path, document]));
  const byId = new Map(
    documents.filter((document) => document.valid && document.id).map((d) => [d.id!, d]),
  );
  const pinned = documents.flatMap((document) =>
    document.path.startsWith(`${CARDS_DIR}/`) && Array.isArray(document.data.sources)
      ? document.data.sources.flatMap((source: unknown, index) =>
          source &&
          typeof source === "object" &&
          !Array.isArray(source) &&
          (source as Record<string, unknown>).version !== undefined
            ? [{ owner: document.path, index, source: source as MaterialSource }]
            : [],
        )
      : [],
  );
  const retained = await verifyCardSourceVersions(readonlyFs, pinned);
  const pinnedChecks = new Map(
    pinned.map((item, index) => [JSON.stringify([item.owner, item.index]), retained[index]!]),
  );
  const fileCache = new Map<string, Promise<boolean>>();
  function exists(filename: string, directory = false) {
    const key = JSON.stringify([filename, directory]);
    let observed = fileCache.get(key);
    if (!observed) {
      observed = fileExists(filename, directory);
      fileCache.set(key, observed);
    }
    return observed;
  }
  async function linkReason(target: string, owner: string): Promise<string | undefined> {
    if (target.startsWith("#") || target.startsWith("//")) return;
    const external = /^[a-z][a-z\d+.-]*:/i.test(target);
    if (external && !/^file:/i.test(target)) return;
    const normalized = resolveTargetPath(target, owner);
    if (isNodeId(normalized) || isRoleId(normalized) || isCardId(normalized))
      return byId.has(normalized) ? undefined : "Document id is missing or invalid";
    const resolved = resolveOutLink(index, { raw: target, kind: "md" }, owner);
    if (resolved.targetNodeId) return;
    const document = byPath.get(normalized) ?? byPath.get(`${normalized}.md`);
    if (document) return document.valid ? undefined : "Target document is invalid";
    let filename: string | undefined;
    let locator: ReturnType<typeof materialLocator>;
    try {
      locator = materialLocator(target, owner);
      filename = localMaterialPath(locator, workspaceRoot);
    } catch (cause) {
      return message(cause);
    }
    const directory = isDirectoryMaterial(locator);
    const kind = directory ? "directory" : "file";
    try {
      if (filename !== undefined && (await exists(filename, directory))) return;
      if (
        target.startsWith("/") &&
        locator.kind === "path" &&
        locator.anchor === "bundle" &&
        (await exists(path.resolve(workspaceRoot, locator.target), directory))
      ) {
        const relative = path.posix.relative(
          path.posix.join(".tent", path.posix.dirname(owner)),
          locator.target,
        );
        const address =
          relative.split("/").map(encodeURIComponent).join("/") +
          (directory && !relative.endsWith("/") ? "/" : "") +
          locator.suffix;
        return `Local link target does not exist as a ${kind}; leading / resolves from .tent; write ${JSON.stringify(address)} relative to this document`;
      }
      return `Local link target does not exist as a ${kind}`;
    } catch (cause) {
      error(owner, `Cannot inspect ${JSON.stringify(target)}: ${message(cause)}`);
    }
  }
  for (const document of documents) {
    const targets = new Set<string>();
    // Reuse the native Markdown parser for local destinations;
    // collecting destinations never rewrites the observed document.
    rewriteMarkdownDestinations(document.body, (target) => {
      targets.add(target);
      return undefined;
    });
    for (const target of targets) {
      const reason = await linkReason(target, document.path);
      if (reason)
        result.issues.push({ kind: "unresolved-link", path: document.path, target, reason });
    }
    async function material(field: "resource" | "sources", value: unknown, index?: number) {
      const occurrence = {
        path: document.path,
        field,
        ...(index === undefined ? {} : { index }),
        ...(typeof value === "string" ? { resource: value } : {}),
      };
      const pinned =
        field === "sources" && index !== undefined
          ? pinnedChecks.get(JSON.stringify([document.path, index]))
          : undefined;
      if (pinned !== undefined) {
        if (pinned instanceof Error)
          result.issues.push({
            kind: "invalid-material-address",
            ...occurrence,
            reason: message(pinned),
          });
        return;
      }
      let filename: string | undefined;
      let sectionResource: string | undefined;
      let directory = false;
      let prefixResource: string | undefined;
      try {
        const parsed = resourceSchema.safeParse(value);
        if (!parsed.success) throw new Error("Material resource must be nonempty text");
        const resource = parsed.data;
        const locator = materialLocator(resource, document.path, field === "sources");
        await assertSystemMaterial(readonlyFs, locator);
        directory = isDirectoryMaterial(locator);
        if (isPrefixMaterial(locator))
          prefixResource =
            locator.kind === "path" && !/^(?:\.{1,2}\/|\/)/.test(resource.trim())
              ? `./${resource.trim()}`
              : resource;
        if (locator.kind === "unresolved") {
          // Descriptive sources stay descriptive. Warn only when today's local
          // files make a bare source look like an accidentally unanchored file.
          const candidates = [
            () => materialLocator(`../${resource.trim()}`, "index.md"),
            () => materialLocator(`./${resource.trim()}`, document.path),
          ];
          for (const candidate of candidates) {
            let possible;
            try {
              possible = candidate();
              await assertSystemMaterial(readonlyFs, possible);
            } catch {
              continue;
            }
            const filename = localMaterialPath(possible, workspaceRoot);
            if (filename === undefined || possible.kind !== "path") continue;
            let present;
            try {
              present = await exists(filename, isDirectoryMaterial(possible));
            } catch (cause) {
              error(document.path, `Cannot inspect ${JSON.stringify(resource)}: ${message(cause)}`);
              return;
            }
            if (!present) continue;
            const relative = path.posix.relative(
              path.posix.dirname(document.path),
              possible.target,
            );
            const encoded = relative.split("/").map(encodeURIComponent).join("/");
            const suggestion =
              (encoded.startsWith("../") ? encoded : `./${encoded}`) +
              (isDirectoryMaterial(possible) && encoded && !encoded.endsWith("/") ? "/" : "") +
              possible.suffix;
            result.issues.push({
              kind: "unanchored-material-file",
              ...occurrence,
              suggestion,
              reason: `Bare source text matches an existing ${isDirectoryMaterial(possible) ? "directory" : "file"} but is not tracked; use ${JSON.stringify(suggestion)} relative to the declaring document`,
            });
            return;
          }
          return;
        }
        filename = localMaterialPath(locator, workspaceRoot);
        if (markdownMaterialHeading(locator) !== undefined)
          sectionResource =
            locator.kind === "path" && !/^(?:\.{1,2}\/|\/)/.test(resource.trim())
              ? `./${resource.trim()}`
              : resource;
      } catch (cause) {
        result.issues.push({
          kind: "invalid-material-address",
          ...occurrence,
          reason: message(cause),
        });
        return;
      }
      if (filename === undefined) return;
      try {
        if (prefixResource !== undefined) {
          if (!readonlyFs.observeMaterial) throw new Error("Material observer is unavailable");
          await readonlyFs.observeMaterial(prefixResource, document.path);
          return;
        }
        if (await exists(filename, directory)) {
          if (sectionResource !== undefined) {
            if (!readonlyFs.observeMaterial) throw new Error("Material observer is unavailable");
            try {
              await readonlyFs.observeMaterial(sectionResource, document.path);
            } catch (cause) {
              if (
                !(cause instanceof NodeSectionError) ||
                !["SECTION_NOT_FOUND", "SECTION_AMBIGUOUS"].includes(cause.code)
              )
                throw cause;
              result.issues.push({
                kind: "missing-material-section",
                ...occurrence,
                reason: message(cause),
              });
            }
          }
          return;
        }
        result.issues.push({
          kind: "missing-material-file",
          ...occurrence,
          reason: directory
            ? "Local material does not exist as a directory"
            : "Local material does not exist as a file",
        });
      } catch (cause) {
        error(document.path, `Cannot inspect ${JSON.stringify(value)}: ${message(cause)}`);
      }
    }
    if (document.data.resource !== undefined) await material("resource", document.data.resource);
    if (document.data.sources !== undefined) {
      if (!Array.isArray(document.data.sources)) {
        result.issues.push({
          kind: "invalid-material-address",
          path: document.path,
          field: "sources",
          reason: "sources must be an array of resource declarations",
        });
      } else {
        for (const [index, source] of document.data.sources.entries()) {
          await material(
            "sources",
            source && typeof source === "object" && !Array.isArray(source)
              ? (source as Record<string, unknown>).resource
              : undefined,
            index,
          );
        }
      }
    }
  }
  const compare = (a: unknown, b: unknown) => {
    const left = JSON.stringify(a),
      right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  };
  result.issues.sort(compare);
  result.notices.sort(compare);
  result.errors.sort(compare);
  return result;
}
