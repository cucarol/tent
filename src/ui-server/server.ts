import { inspectWorkspaceSync, readOutputComparisons } from "../core/graph/node-sync.js";
import { readNodeTimes } from "../core/read/node-times.js";
import { readMaterialOverlaps } from "../core/read/material-overlaps.js";
// The local service behind `tent ui`: serves the bundled Web UI and a small JSON API over Core.
// Its contract is the Tent Node "Web界面服务接口"; it is not a public protocol.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as fsp from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { userInfo } from "node:os";
import * as path from "node:path";
import {
  createCardDocument,
  deprecateCardDocument,
  moveCardDocument,
  readCardDocument,
  CardDocumentError,
} from "../core/graph/card-document.js";
import { ReaderError } from "../core/graph/context-reader.js";
import {
  CANVAS_LIMIT,
  CanvasError,
  readCanvasDocument,
  writeCanvasDocument,
} from "../core/workspace/canvas.js";
import { readDocumentDiff, readDocumentVersion } from "../core/read/document-diff.js";
import { parseFrontmatter, serializeFrontmatter } from "../core/base/frontmatter.js";
import { documentVersionSchema } from "../core/store/git-history.js";
import { NodeWriteError, writeNodeDocument } from "../core/graph/node-document-write.js";
import { nodeTrustTier } from "../core/base/node-provenance.js";
import { confirmNodeSync } from "../core/graph/node-sync.js";
import { archiveNode, restoreNode } from "../core/graph/node-lifecycle.js";
import { deleteNode, renameNode } from "../core/graph/ops.js";
import { editRoleContext } from "../core/read/role-context.js";
import { deleteRole, RoleDeleteError } from "../core/write/role-delete.js";
import { readRoleDocument } from "../core/store/role-document.js";
import { readNodeForEdit } from "../core/read/node-query.js";
import { TENT_SYSTEM_DIR, workspaceRootFromSystemRoot } from "../core/base/paths.js";
import { findTentSystemRoot } from "../core/workspace/status.js";
import { readWorkspaceRevision } from "../core/workspace/workspace-revision.js";
import { readWorkspaceSettings } from "../core/workspace/workspace-settings.js";
import { readModuleDependencies } from "../core/graph/module-dependencies.js";
import { createModuleDependencyQuery } from "../core/read/module-dependency-query.js";
import { validationIssueText } from "../core/base/validation-message.js";
import { NodeFs, SystemClock } from "../fs/node-fs.js";
import { createModuleDependencyRepositoryReader } from "../fs/module-dependencies.js";
import { createModuleDependencyWatch } from "../fs/module-dependency-watch.js";
import type { Snapshot } from "../ui/data/types.js";
import { buildSnapshot } from "./snapshot.js";
import { shareInFlightReads } from "./shared-reads.js";
import { readWorkspaces, rememberWorkspace, workspaceKey } from "./workspaces.js";

export type UiServerOptions = {
  workspaceRoot: string;
  /** The built UI (ui-dist). */
  staticDir: string;
  /** Fixed port; without it the workspace's own port is tried, then any free one. */
  port?: number;
  /** The per-user list of opened workspaces behind the page's switcher; without it the list is empty. */
  workspacesFile?: string;
  /** Seconds without a successful authenticated page request before closing the whole UI session. */
  idleTimeout?: number;
};
export type UiServer = {
  url: string;
  port: number;
  /** The workspace's own port, when something else held it and a free one was used instead. */
  portTaken?: number;
  /** Resolves after closure, including an automatic idle shutdown. */
  closed: Promise<void>;
  close(): Promise<void>;
};

const MB = 1024 * 1024;
const BODY_LIMIT = { document: 2 * MB };
const FILE_LIMIT = 20 * MB;
/** Audio and video play from a blob in the page, so they get a larger, still bounded, allowance. */
const MEDIA_LIMIT = 200 * MB;
const MEDIA_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};
const FILE_TYPES: Record<string, string> = {
  ...MEDIA_TYPES,
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
};
/** How many paths one file-info request may ask about. */
const INFO_LIMIT = 2000;
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};
const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ...IMAGE_TYPES,
};
// Map positions use inline styles; Markdown may show images from the web.
const PAGE_POLICY = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data: http: https:",
  // Workspace HTML previews in a sandboxed frame, and audio or video, load from blobs of /api/files.
  "frame-src blob:",
  "media-src blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Workspaces this process serves, so switching back finds the open one instead of starting another. */
const serving = new Map<string, Promise<UiServer>>();

/** Each workspace keeps one port, so what the browser stores for its origin survives restarts. */
export function workspacePort(workspaceId: string): number {
  return 47800 + (createHash("sha256").update(workspaceId).digest().readUInt32BE(0) % 1000);
}

export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  if (
    options.idleTimeout !== undefined &&
    (!Number.isSafeInteger(options.idleTimeout) ||
      options.idleTimeout < 1 ||
      options.idleTimeout > Math.floor(2_147_483_647 / 1000))
  )
    throw new Error("idleTimeout must be an integer between 1 and 2147483 seconds");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let root: UiServer | undefined;
  let closing = false;
  // Activity in an opened workspace renews the same session; otherwise switching
  // away from the first workspace would close a page that is still being used.
  const activity = () => {
    if (!options.idleTimeout || !root || closing) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      void root!.close().catch((error) => console.error(error));
    }, options.idleTimeout * 1000);
  };
  root = await startWorkspaceServer(options, activity);
  const close = root.close;
  root.close = () => {
    closing = true;
    clearTimeout(timer);
    return close();
  };
  activity();
  return root;
}

async function startWorkspaceServer(
  options: UiServerOptions,
  activity: () => void,
): Promise<UiServer> {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const tentRoot = path.join(workspaceRoot, TENT_SYSTEM_DIR);
  const staticDir = path.resolve(options.staticDir);
  const fs = new NodeFs(tentRoot, "ui");
  const queryFs = shareInFlightReads(fs);
  const env = { fs, clock: new SystemClock(), tentName: workspaceRoot, tentRoot };
  const dependencyRepository = createModuleDependencyRepositoryReader(workspaceRoot);
  const dependencyQuery = createModuleDependencyQuery({
    compute: () => readModuleDependencies(queryFs, workspaceRoot, dependencyRepository()),
    watch: (changed, unavailable) =>
      createModuleDependencyWatch(workspaceRoot, changed, unavailable),
    reportMode: (mode, reason) =>
      console.error(`Tent module dependencies: ${mode}${reason ? ` (${reason})` : ""}`),
  });
  const { workspaceId } = await readWorkspaceSettings(fs);
  if (!workspaceId) throw new Error(`Workspace has no workspaceId: ${tentRoot}`);
  const workspace = { id: workspaceId, name: path.basename(workspaceRoot) };
  const key = workspaceKey(workspaceRoot);
  // Workspaces opened from this page close with it.
  const opened = new Set<Promise<UiServer>>();
  const token = randomBytes(32).toString("base64url");
  const tokenDigest = createHash("sha256").update(token).digest();
  let port = 0;
  let cached: Snapshot | undefined;
  let building: { revision: string; fresh: boolean; snapshot: Promise<Snapshot> } | undefined;
  // Queue writes from this service before entering Tent's bounded cross-process lock wait.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(write: () => Promise<T>): Promise<T> => {
    const run = queue.then(write, write);
    queue = run.catch(() => undefined);
    return run;
  };

  /**
   * One build per revision, shared by every request that arrives while it runs. A fresh build reruns
   * the same revision: material changes outside Tent move Card progress without a new revision.
   */
  const snapshot = async (fresh = false) => {
    const revision = await readWorkspaceRevision(queryFs);
    if (!fresh && cached?.workspace.revision === revision) return cached;
    if (building?.revision !== revision || (fresh && !building.fresh)) {
      const pending = buildSnapshot({ fs: queryFs, workspace, revision });
      building = { revision, fresh, snapshot: pending };
      pending.then(
        (built) => {
          cached = built;
          if (building?.snapshot === pending) building = undefined;
        },
        () => {
          if (building?.snapshot === pending) building = undefined;
        },
      );
    }
    return building!.snapshot;
  };

  const origins = () => [`127.0.0.1:${port}`, `localhost:${port}`];
  const authorized = (req: IncomingMessage) => {
    const given = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
    return !!given && timingSafeEqual(createHash("sha256").update(given).digest(), tokenDigest);
  };

  async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (!authorized(req))
      throw new HttpError(401, "UNAUTHORIZED", "Open the link printed by tent ui");
    const method = req.method ?? "GET";
    const write = method !== "GET" && method !== "HEAD";
    if (write && !req.headers.origin)
      throw new HttpError(403, "FORBIDDEN_ORIGIN", "Writes must come from the Tent UI page");
    if (write && !/^application\/json\b/.test(req.headers["content-type"] ?? ""))
      throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Send JSON");
    res.once("finish", () => {
      if (res.statusCode >= 200 && res.statusCode < 400) activity();
    });
    const route = `${method} ${url.pathname}`;
    const nodeId = /^\/api\/nodes\/([^/]+)$/.exec(url.pathname)?.[1];
    const nodeConfirmId = /^\/api\/nodes\/([^/]+)\/confirm$/.exec(url.pathname)?.[1];
    const cardRoute = /^\/api\/cards\/([^/]+)(?:\/(move|deprecate))?$/.exec(url.pathname);
    const nodeAction = /^\/api\/nodes\/([^/]+)\/(archive|restore|rename)$/.exec(url.pathname);
    const roleRoute = /^\/api\/roles\/([^/]+)(?:\/(status))?$/.exec(url.pathname);

    if (route === "GET /api/revision")
      return json(res, 200, { revision: await readWorkspaceRevision(queryFs) });
    if (route === "GET /api/canvas") return json(res, 200, await readCanvasDocument(fs));
    if (route === "PUT /api/canvas") {
      // Allow the CAS envelope as well as a canvas at the file-size limit.
      const input = record(await readJson(req, CANVAS_LIMIT + 1024));
      return json(
        res,
        200,
        await serial(() =>
          writeCanvasDocument(fs, {
            baseEtag: input.baseEtag,
            canvas: input.canvas,
          }),
        ),
      );
    }
    if (route === "GET /api/modules/deps") return json(res, 200, await dependencyQuery.read());
    if (route === "GET /api/nodes/material-overlaps")
      return json(
        res,
        200,
        await readMaterialOverlaps(queryFs, workspaceRoot, url.searchParams.getAll("nodeId")),
      );
    if (route === "GET /api/outputs/compare")
      return json(
        res,
        200,
        await readOutputComparisons(queryFs, url.searchParams.getAll("nodeId")),
      );
    if (route === "GET /api/nodes/times")
      return json(res, 200, await readNodeTimes(queryFs, url.searchParams.getAll("nodeId")));
    if (route === "GET /api/sync") {
      // The initial UI read runs beside the snapshot; keep its starting document revision.
      const revision = await readWorkspaceRevision(queryFs);
      const sync = await inspectWorkspaceSync(queryFs);
      return json(res, 200, {
        revision,
        nodes: Object.fromEntries(
          sync.nodes
            .filter((n) => n.ahead || n.behind)
            .map((n) => [
              n.nodeId,
              { ...(n.ahead ? { ahead: n.ahead } : {}), ...(n.behind ? { behind: n.behind } : {}) },
            ]),
        ),
      });
    }
    if (route === "GET /api/snapshot") {
      const fresh = url.searchParams.get("fresh") === "1";
      const current = await snapshot(fresh);
      const etag = `"${current.workspace.revision}"`;
      if (!fresh && req.headers["if-none-match"] === etag) return end(res, 304, { ETag: etag });
      return json(res, 200, current, { ETag: etag });
    }
    if (nodeId && method === "GET") {
      const read = async () => {
        const document = await readNodeForEdit(fs, decodeURIComponent(nodeId), {
          capture: url.searchParams.get("capture") === "true",
        });
        return { ...document, trustTier: nodeTrustTier(document.frontmatter) };
      };
      // A capture records history, so it waits its turn like a write.
      return json(
        res,
        200,
        await (url.searchParams.get("capture") === "true" ? serial(read) : read()),
      );
    }
    if (nodeConfirmId && method === "POST") {
      const id = decodeURIComponent(nodeConfirmId);
      const input = record(await readJson(req, BODY_LIMIT.document));
      const saved = await serial(() =>
        confirmNodeSync(fs, id, {
          baseEtag: requiredString(input.baseEtag, "baseEtag"),
          by: optionalString(input.by, "by") ?? `human:${userInfo().username}`,
        }),
      );
      const parsed = parseFrontmatter(saved.raw);
      return json(res, 200, {
        nodeId: saved.nodeId,
        path: saved.path,
        etag: saved.etag,
        changed: saved.changed,
        version: saved.version,
        body: parsed.body,
        trustTier: nodeTrustTier(parsed.data),
      });
    }
    if (nodeId && method === "PUT") {
      const id = decodeURIComponent(nodeId);
      const input = record(await readJson(req, BODY_LIMIT.document));
      try {
        const saved = await serial(() =>
          writeNodeDocument(fs, id, {
            baseEtag: optionalString(input.baseEtag, "baseEtag"),
            body: optionalString(input.body, "body"),
            raw: optionalString(input.raw, "raw"),
            frontmatter: input.frontmatter === undefined ? undefined : record(input.frontmatter),
            by: optionalString(input.by, "by") ?? `human:${userInfo().username}`,
          }),
        );
        const parsed = parseFrontmatter(saved.raw);
        return json(res, 200, {
          nodeId: saved.nodeId,
          path: saved.path,
          etag: saved.etag,
          changed: saved.changed,
          version: saved.version,
          body: parsed.body,
          trustTier: nodeTrustTier(parsed.data),
        });
      } catch (error) {
        if (error instanceof NodeWriteError && error.code === "ETAG_CONFLICT") {
          const current = await readNodeForEdit(fs, id).catch(() => undefined);
          throw new HttpError(409, error.code, error.message, {
            current: current && { etag: current.etag, body: current.body },
          });
        }
        throw error;
      }
    }
    // Removing or archiving a whole subtree, or renaming a Node, goes through Core's structural writes.
    if (nodeId && method === "DELETE")
      return json(
        res,
        200,
        await serial(() => managed(deleteNode(env, decodeURIComponent(nodeId)))),
      );
    if (nodeAction && method === "POST") {
      const id = decodeURIComponent(nodeAction[1]!);
      const input = record(await readJson(req, BODY_LIMIT.document));
      return json(
        res,
        200,
        await serial(() =>
          managed<unknown>(
            nodeAction[2] === "archive"
              ? archiveNode(env, id)
              : nodeAction[2] === "restore"
                ? restoreNode(env, id, requiredString(input.archiveCommit, "archiveCommit"))
                : renameNode(env, id, requiredString(input.name, "name")),
          ),
        ),
      );
    }
    if (roleRoute) {
      const id = decodeURIComponent(roleRoute[1]!);
      if (method === "GET" && !roleRoute[2]) {
        const doc = await managed(readRoleDocument(fs, id));
        return json(res, 200, {
          roleId: doc.roleId,
          path: doc.path,
          etag: doc.etag,
          body: doc.body,
        });
      }
      // Deleting needs the ETag the page read; pending Cards for the Role refuse it with their ids.
      if (method === "DELETE" && !roleRoute[2]) {
        const input = record(await readJson(req, BODY_LIMIT.document));
        const baseEtag = requiredString(input.baseEtag, "baseEtag");
        return json(res, 200, await serial(() => managed(deleteRole(fs, id, { baseEtag }))));
      }
      // Archiving a Role is its lifecycle status; restoring removes the field (omitted means stable).
      if (method === "POST" && roleRoute[2]) {
        const input = record(await readJson(req, BODY_LIMIT.document));
        const baseEtag = requiredString(input.baseEtag, "baseEtag");
        const archived = input.archived === true;
        return json(
          res,
          200,
          await serial(() =>
            managed(
              (async () => {
                const current = await readRoleDocument(fs, id);
                const { data, body, keyOrder } = parseFrontmatter(current.raw);
                const { status: _, ...rest } = data;
                const raw = archived
                  ? serializeFrontmatter({ ...data, status: "deprecated" }, body, keyOrder)
                  : serializeFrontmatter(rest, body, keyOrder);
                return editRoleContext(fs, id, { baseEtag, raw });
              })(),
            ),
          ),
        );
      }
    }
    if (cardRoute) {
      const id = decodeURIComponent(cardRoute[1]!);
      const action = cardRoute[2];
      if (method === "GET" && !action) return json(res, 200, await readCardDocument(fs, id));
      if (method === "POST" && action === "deprecate") {
        const input = record(await readJson(req, BODY_LIMIT.document));
        const expectedEtag = requiredString(input.baseEtag, "baseEtag");
        return json(res, 200, await serial(() => deprecateCardDocument(fs, id, expectedEtag)));
      }
      if (method === "POST" && action) {
        const input = record(await readJson(req, BODY_LIMIT.document));
        return json(
          res,
          200,
          await serial(async () => {
            const expectedEtag = requiredString(input.baseEtag, "baseEtag");
            return moveCardDocument(fs, id, {
              expectedEtag,
              target:
                input.target === undefined
                  ? undefined
                  : input.target === null
                    ? null
                    : requiredString(input.target, "target"),
              before:
                input.before === undefined ? undefined : requiredString(input.before, "before"),
              after: input.after === undefined ? undefined : requiredString(input.after, "after"),
            });
          }),
        );
      }
    }
    if (route === "POST /api/cards") {
      const input = record(await readJson(req, BODY_LIMIT.document));
      return json(res, 200, await serial(async () => createCardDocument(fs, cardInput(input))));
    }
    if (route === "GET /api/history/document")
      return json(res, 200, await readDocumentVersion(fs, versionParam(url, "at")));
    if (route === "GET /api/history/diff") {
      const diff = await readDocumentDiff(fs, {
        from: versionParam(url, "from"),
        to: versionParam(url, "to"),
      });
      return json(res, 200, { text: diff.text, pathChanged: diff.pathChanged });
    }
    if (route === "GET /api/workspaces") return json(res, 200, { workspaces: await known() });
    if (route === "POST /api/workspaces/open") {
      const input = record(await readJson(req, BODY_LIMIT.document));
      const target = requiredString(input.path, "path").trim();
      if (!path.isAbsolute(target))
        throw new HttpError(422, "INVALID_INPUT", "Give the folder's full path");
      const root = await workspaceAt(target);
      if (!root) throw new HttpError(422, "NOT_A_WORKSPACE", `No Tent workspace at ${target}`);
      const other = await openWorkspace(root);
      return json(res, 200, {
        url: other.url,
        ...(other.portTaken === undefined ? {} : { portTaken: other.portTaken }),
      });
    }
    if (route === "GET /api/files") return file(res, url.searchParams.get("path") ?? "");
    // A read sent as POST: the list of paths can outgrow a URL.
    if (route === "POST /api/files/info") {
      const paths = record(await readJson(req, BODY_LIMIT.document)).paths;
      if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string"))
        throw new HttpError(422, "INVALID_INPUT", "paths must be a list of workspace paths");
      return json(res, 200, await fileInfo(paths));
    }
    throw new HttpError(404, "NOT_FOUND", `No such endpoint: ${route}`);
  }

  /** Opened workspaces that still exist, newest first, with this one marked and always present. */
  async function known() {
    const list = options.workspacesFile ? await readWorkspaces(options.workspacesFile) : [];
    const present = await Promise.all(
      list.map(async (w) =>
        workspaceKey(w.root) === key || (await workspaceAt(w.root)) ? w : null,
      ),
    );
    const items = present.flatMap((w) => (w ? [{ root: w.root, name: w.name }] : []));
    if (!items.some((w) => workspaceKey(w.root) === key))
      items.unshift({ root: workspaceRoot, name: workspace.name });
    return items.map((w) => ({ ...w, current: workspaceKey(w.root) === key }));
  }

  /** Another workspace in this process: the one already served, or a new service on its own port. */
  async function openWorkspace(root: string): Promise<UiServer> {
    if (closing) throw new HttpError(503, "BUSY", "The UI service is closing");
    if (workspaceKey(root) === key) return self;
    const found = serving.get(workspaceKey(root));
    if (found) {
      const other = await found;
      // Coming back counts as opening it again.
      if (options.workspacesFile) {
        const { workspaceId: id } = await readWorkspaceSettings(
          new NodeFs(path.join(root, TENT_SYSTEM_DIR), "ui"),
        );
        if (id)
          await rememberWorkspace(options.workspacesFile, {
            root,
            name: path.basename(root),
            id,
          }).catch(() => undefined);
      }
      return other;
    }
    // Held in the map while it starts, so a second click does not start it twice.
    const starting = startWorkspaceServer(
      {
        workspaceRoot: root,
        staticDir,
        workspacesFile: options.workspacesFile,
      },
      activity,
    );
    serving.set(workspaceKey(root), starting);
    opened.add(starting);
    return starting.catch((error: unknown) => {
      opened.delete(starting);
      if (serving.get(workspaceKey(root)) === starting) serving.delete(workspaceKey(root));
      throw error;
    });
  }

  /**
   * A workspace file by its workspace-relative path, after following links. Paths that leave the
   * workspace, are absolute, or reach into a `.git` directory are refused with 403.
   */
  async function workspaceFile(relative: string) {
    if (!relative) throw new HttpError(422, "INVALID_INPUT", "A workspace path is required");
    const parts = relative.split("/");
    const outside = () =>
      new HttpError(403, "FORBIDDEN_PATH", "Only files inside the workspace can be read");
    if (
      relative.startsWith("/") ||
      /[\\\0:]/.test(relative) ||
      parts.some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git")
    )
      throw outside();
    const root = await fsp.realpath(workspaceRoot);
    const real = await fsp.realpath(path.join(root, ...parts)).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
      throw new HttpError(404, "NOT_FOUND", `No such file: ${relative}`);
    });
    if (!real.startsWith(root + path.sep)) throw outside();
    // A link inside the workspace may still lead into a Git directory; the rule holds for where it ends.
    if (
      path
        .relative(root, real)
        .split(path.sep)
        .some((p) => p.toLowerCase() === ".git")
    )
      throw outside();
    const stat = await fsp.stat(real);
    if (!stat.isFile()) throw new HttpError(404, "NOT_FOUND", `No such file: ${relative}`);
    return { real, stat };
  }

  /**
   * Serves a workspace file for the page to show. Responses never run as this origin: the page fetches
   * them with its token and shows them from blobs, and a sandbox policy covers a direct visit.
   */
  async function file(res: ServerResponse, relative: string) {
    const { real, stat } = await workspaceFile(relative);
    const ext = path.extname(relative).toLowerCase();
    const type = IMAGE_TYPES[ext] ?? FILE_TYPES[ext] ?? "application/octet-stream";
    const limit = MEDIA_TYPES[ext] ? MEDIA_LIMIT : FILE_LIMIT;
    if (stat.size > limit)
      throw new HttpError(413, "TOO_LARGE", `File is larger than ${limit / MB} MB`);
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": stat.size,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
    });
    res.end(await fsp.readFile(real));
  }

  /** Size and modification time of workspace files; null for a missing file or a refused path. */
  async function fileInfo(paths: string[]) {
    if (paths.length > INFO_LIMIT)
      throw new HttpError(422, "INVALID_INPUT", `At most ${INFO_LIMIT} paths per request`);
    // A Map, not an object: any file name is a key, `__proto__` included.
    const files = new Map<string, { size: number; modifiedAt: string } | null>();
    for (const relative of new Set(paths)) {
      try {
        const { stat } = await workspaceFile(relative);
        files.set(relative, { size: stat.size, modifiedAt: stat.mtime.toISOString() });
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        files.set(relative, null);
      }
    }
    return { files: Object.fromEntries(files) };
  }

  async function page(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (req.method !== "GET" && req.method !== "HEAD") return end(res, 405, { Allow: "GET, HEAD" });
    const relative =
      url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const target = path.resolve(staticDir, relative);
    const type = STATIC_TYPES[path.extname(target).toLowerCase()];
    if (!type || !target.startsWith(staticDir + path.sep)) return end(res, 404);
    const stat = await fsp.stat(target).catch((error: unknown) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (!stat?.isFile()) return end(res, 404);
    const headers: Record<string, string | number> = {
      "Content-Type": type,
      "Content-Length": stat.size,
      "Last-Modified": stat.mtime.toUTCString(),
      // Chunk names carry content hashes; everything else is revalidated.
      "Cache-Control": relative.startsWith("chunks/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    };
    if (type.startsWith("text/html")) headers["Content-Security-Policy"] = PAGE_POLICY;
    const since = Date.parse(req.headers["if-modified-since"] ?? "");
    if (since && Math.floor(stat.mtimeMs / 1000) * 1000 <= since) return end(res, 304, headers);
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : await fsp.readFile(target));
  }

  const server = createServer((req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      return end(res, 400);
    }
    const isApi = url.pathname.startsWith("/api/");
    if (isApi) res.setHeader("Cache-Control", "no-store");
    const handle = async () => {
      // A foreign Host means DNS rebinding; a foreign Origin means another site's page.
      if (!origins().includes(req.headers.host ?? ""))
        throw new HttpError(403, "FORBIDDEN_HOST", "Unexpected Host");
      const origin = req.headers.origin;
      if (origin && !origins().some((o) => origin === `http://${o}`))
        throw new HttpError(403, "FORBIDDEN_ORIGIN", "Unexpected Origin");
      return isApi ? api(req, res, url) : page(req, res, url);
    };
    handle().catch((error: unknown) => {
      const failure = httpError(error);
      if (res.headersSent) return res.destroy();
      if (!isApi) return end(res, failure.status);
      json(res, failure.status, {
        error: {
          code: failure.code,
          message: failure.message,
          ...(failure.details ? { details: failure.details } : {}),
        },
      });
    });
  });

  const own = options.port ?? workspacePort(workspaceId);
  let portTaken: number | undefined;
  port = await listen(server, own).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EADDRINUSE" || options.port !== undefined) throw error;
    portTaken = own;
    return listen(server, 0);
  });
  let closing: Promise<void> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const self: UiServer = {
    url: `http://127.0.0.1:${port}/#token=${token}`,
    port,
    closed,
    ...(portTaken === undefined ? {} : { portTaken }),
    // Once is enough: later calls wait for the same close.
    close: () =>
      (closing ??= (async () => {
        if (serving.get(key) === registered) serving.delete(key);
        const stopped = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
        await Promise.all([
          stopped,
          dependencyQuery.close(),
          ...[...opened].map(async (starting) => {
            const other = await starting.catch(() => undefined);
            await other?.close();
          }),
        ]);
        opened.clear();
      })().finally(resolveClosed)),
  };
  const registered = Promise.resolve(self);
  serving.set(key, registered);
  // The list is a convenience: failing to keep it never stops the service.
  if (options.workspacesFile)
    await rememberWorkspace(options.workspacesFile, {
      root: workspaceRoot,
      name: workspace.name,
      id: workspaceId,
    }).catch(() => undefined);
  return self;
}

/** The workspace whose root is `folder` (or whose `.tent` it is); parents are not searched. */
async function workspaceAt(folder: string): Promise<string | undefined> {
  const systemRoot = await findTentSystemRoot(folder, folder);
  const root = systemRoot && workspaceRootFromSystemRoot(systemRoot);
  return root ? path.resolve(root) : undefined;
}

function listen(server: ReturnType<typeof createServer>, port: number) {
  return new Promise<number>((resolve, reject) => {
    const fail = (error: Error) => reject(error);
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", fail);
      resolve((server.address() as { port: number }).port);
    });
  });
}

/** Only a missing path is "not found"; other filesystem failures reach httpError. */
function isMissing(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException)?.code ?? "");
}

/**
 * Core's structural and Role writes reject with plain errors: an unknown object is 404, a refusal
 * (a name collision, an unsupported status, a stale ETag) is 409 with Core's own message.
 */
async function managed<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof RoleDeleteError)
      throw new HttpError(409, error.code, error.message, error.details);
    const message = error instanceof Error ? error.message : String(error);
    if (/already running another write operation/.test(message)) throw error;
    if (/not found/i.test(message)) throw new HttpError(404, "NOT_FOUND", message);
    if ((error as Error)?.name === "ZodError") throw error;
    throw new HttpError(409, "REJECTED", message);
  }
}

function httpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof CanvasError)
    return new HttpError(
      error.code === "ETAG_CONFLICT" ? 409 : 422,
      error.code,
      error.message,
      error.details,
    );
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof NodeWriteError) {
    const status = error.code === "ETAG_CONFLICT" ? 409 : error.code === "NOT_FOUND" ? 404 : 422;
    return new HttpError(status, error.code, message);
  }
  if (error instanceof ReaderError) {
    const status = error.code === "NOT_FOUND" ? 404 : error.code === "SOURCE_CHANGED" ? 409 : 422;
    return new HttpError(status, error.code, message);
  }
  if (error instanceof CardDocumentError)
    return new HttpError(
      error.code === "INVALID_DOCUMENT" || error.code === "ROLE_UNAVAILABLE" ? 422 : 409,
      error.code,
      message,
      error.details,
    );
  if (error instanceof Error && error.name === "ZodError")
    return new HttpError(422, "INVALID_INPUT", validationIssueText(error) ?? message);
  // Another Tent writer (the CLI, say) holds the lock; nothing was written, so the page retries.
  if (/already running another write operation|Tent mutation lock is still busy/.test(message))
    return new HttpError(503, "BUSY", message);
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
    return new HttpError(404, "NOT_FOUND", message);
  return new HttpError(500, "INTERNAL", message);
}

function versionParam(url: URL, name: string) {
  const value = url.searchParams.get(name) ?? "";
  const split = value.indexOf(":");
  if (split < 0) throw new HttpError(422, "INVALID_INPUT", `${name} must be <commit>:<path>`);
  return documentVersionSchema.parse({
    commit: value.slice(0, split),
    path: value.slice(split + 1),
  });
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "TOO_LARGE", "Request body is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Request body is not JSON");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(422, "INVALID_INPUT", "Expected a JSON object");
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new HttpError(422, "INVALID_INPUT", `${name} must be text`);
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new HttpError(422, "INVALID_INPUT", `${name} must be text`);
  return value;
}

function cardInput(input: Record<string, unknown>) {
  return {
    prompt: requiredString(input.prompt, "prompt"),
    title: optionalString(input.title, "title"),
    target: input.target === null ? undefined : optionalString(input.target, "target"),
    returnTo: input.returnTo === null ? undefined : optionalString(input.returnTo, "returnTo"),
    sources: input.sources === undefined ? undefined : (input.sources as never),
  };
}

function json(
  res: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    ...headers,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function end(res: ServerResponse, status: number, headers: Record<string, string | number> = {}) {
  res.writeHead(status, headers);
  res.end();
}
