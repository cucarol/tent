import type { FsAdapter } from "./adapter.js";
import path from "node:path";
import { readOnlyFs } from "./adapter.js";
import { loadTent } from "./tree.js";
import { buildNodeIndex } from "./okf-index.js";
import { resolveOutLink, rewriteMarkdownDestinations } from "../markdown/links.js";
import { resolveTargetPath } from "./link-target.js";
import { parseFrontmatter } from "./frontmatter.js";
import { parseRoleDocument } from "./role-document.js";
import { parseCardDocument, verifyCardSourceVersions } from "./card-document.js";
import {
  materialLocator,
  localMaterialPath,
  resourceSchema,
  type MaterialSource,
} from "./material.js";
import { CARDS_DIR, ROLES_DIR, ORDER_PATH, nodeNotePath } from "./paths.js";
import { isNodeId, isRoleId, isCardId } from "./id.js";
import { markdownMaterialHeading } from "./material-section.js";
import { NodeSectionError } from "./markdown-section.js";
import { retainedNodeRecords, syncMaterialIdentity } from "./node-sync-record.js";

export type GraphCheckIssue =
  | { kind: "unresolved-link"; path: string; target: string; reason: string }
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
  notices: {
    kind: "relocated-material-file";
    path: string;
    field: "resource" | "sources";
    index?: number;
    resource?: string;
    checkout: string;
    reason: string;
  }[];
  errors: { path: string; reason: string }[];
};

/** Host file inspection is injected; false means missing or not a regular file. */
export type GraphFileExists = (absolutePath: string) => Promise<boolean>;

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
  const nodeRecords = await retainedNodeRecords(readonlyFs);
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
  for (const [directory, kind] of [
    [ROLES_DIR, "role"],
    [CARDS_DIR, "card"],
  ] as const) {
    if (!(await observationFs.exists(directory))) continue;
    for (const entry of await observationFs.listDir(directory)) {
      if (entry.isDir || !entry.name.endsWith(".md")) continue;
      const id = entry.name.slice(0, -3);
      await readDocument(`${directory}/${entry.name}`, (raw) => {
        if (kind === "role") parseRoleDocument(id, raw);
        else parseCardDocument(id, raw);
      });
    }
  }
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
  function exists(filename: string) {
    let observed = fileCache.get(filename);
    if (!observed) {
      observed = fileExists(filename);
      fileCache.set(filename, observed);
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
    try {
      const locator = materialLocator(target, owner);
      filename = localMaterialPath(locator, workspaceRoot);
    } catch (cause) {
      return message(cause);
    }
    try {
      if (filename !== undefined && (await exists(filename))) return;
      return "Local link target does not exist as a file";
    } catch (cause) {
      error(owner, `Cannot inspect ${JSON.stringify(target)}: ${message(cause)}`);
    }
  }
  for (const document of documents) {
    const targets = new Set<string>();
    // Reuse the native Markdown parser, including attachment destinations;
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
      try {
        const parsed = resourceSchema.safeParse(value);
        if (!parsed.success) throw new Error("Material resource must be nonempty text");
        const resource = parsed.data;
        const locator = materialLocator(resource, document.path, field === "sources");
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
            } catch {
              continue;
            }
            const filename = localMaterialPath(possible, workspaceRoot);
            if (filename === undefined || possible.kind !== "path") continue;
            let present;
            try {
              present = await exists(filename);
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
              (encoded.startsWith("../") ? encoded : `./${encoded}`) + possible.suffix;
            result.issues.push({
              kind: "unanchored-material-file",
              ...occurrence,
              suggestion,
              reason: `Bare source text matches an existing file but is not tracked; use ${JSON.stringify(suggestion)} relative to the declaring document`,
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
        const repository =
          typeof value === "string" && document.id
            ? nodeRecords[document.id]?.materials.find(
                (material) => material.identity === syncMaterialIdentity(value, document.path),
              )?.repository
            : undefined;
        if (!(await exists(filename)) && repository && readonlyFs.observeMaterial) {
          try {
            const resource =
              typeof value === "string" &&
              !/^(?:\.{1,2}\/|\/|[a-z][a-z\d+.-]*:)/i.test(value.trim())
                ? `./${value.trim()}`
                : String(value);
            const observed = await readonlyFs.observeMaterial(resource, document.path, repository);
            if (observed.readFrom)
              result.notices.push({
                kind: "relocated-material-file",
                ...occurrence,
                checkout: observed.readFrom,
                reason: `从 ${observed.readFrom} 读取`,
              });
            return;
          } catch (cause) {
            if (
              cause instanceof NodeSectionError &&
              ["SECTION_NOT_FOUND", "SECTION_AMBIGUOUS"].includes(cause.code)
            ) {
              result.issues.push({
                kind: "missing-material-section",
                ...occurrence,
                reason: message(cause),
              });
              return;
            }
            if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
          }
        }
        if (await exists(filename)) {
          if (sectionResource !== undefined) {
            if (!readonlyFs.observeMaterial) throw new Error("Material observer is unavailable");
            try {
              await readonlyFs.observeMaterial(sectionResource, document.path, repository);
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
          reason: "Local material does not exist as a file",
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
