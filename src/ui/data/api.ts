// Client for the `tent ui` service (contract: Tent Node "Web界面服务接口").
// The token arrives once in the URL fragment and is kept for this tab only.
import { t } from "../i18n.js";
import type { WorkspaceMap } from "../../core/read/workspace-map.js";
import type {
  CardState,
  CodeFacts,
  DocumentVersion,
  OutputComparison,
  Snapshot,
  SyncFlags,
  NodeHistoryDetails,
  NodeCardsDetails,
  NodeRelationsDetails,
} from "./types.js";

const TOKEN_KEY = "tent-token";

function takeToken(): string | null {
  if (typeof location === "undefined") return null; // unit tests
  const given = new URLSearchParams(location.hash.slice(1)).get("token");
  if (given) {
    try {
      sessionStorage.setItem(TOKEN_KEY, given);
    } catch {
      /* the token still works for this page */
    }
    history.replaceState(null, "", location.pathname + location.search);
    return given;
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
// Read before the App looks at the fragment for the selected object.
const token = takeToken();

/** A workspace `tent ui` has opened on this computer; `current` is the one this page shows. */
export type KnownWorkspace = { root: string; name: string; current: boolean };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** What to tell the user when a request fails. */
export function describe(error: unknown): string {
  if (error instanceof ApiError && error.code === "NO_TOKEN") return t.app.noToken;
  if (error instanceof ApiError && error.status === 401) return t.app.restarted;
  if (error instanceof ApiError && error.status === 0) return t.app.offline;
  return error instanceof Error ? error.message : String(error);
}

async function call<T>(path: string, init: RequestInit = {}, attempt = 0): Promise<T> {
  if (!token) throw new ApiError(401, "NO_TOKEN", "No token");
  try {
    return await request<T>(path, init);
  } catch (error) {
    // Another Tent writer held the lock and nothing was written; try again shortly.
    if (!(error instanceof ApiError && error.code === "BUSY") || attempt >= 4) throw error;
    await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    return call<T>(path, init, attempt + 1);
  }
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError(0, "OFFLINE", "The service is not reachable");
  }
  if (response.status === 304) return null as T;
  const data = (await response.json().catch(() => null)) as {
    error?: { code: string; message: string; details?: Record<string, unknown> };
  } | null;
  if (!response.ok)
    throw new ApiError(
      response.status,
      data?.error?.code ?? `HTTP_${response.status}`,
      data?.error?.message ?? response.statusText,
      data?.error?.details,
    );
  return data as T;
}

/** Fires after each successful write, so the page refreshes without waiting for the next check. */
export const changes = new EventTarget();
const wrote = <T>(result: Promise<T>) =>
  result.then((value) => {
    changes.dispatchEvent(new Event("change"));
    return value;
  });

const at = (v: DocumentVersion) => encodeURIComponent(`${v.commit}:${v.path}`);
const send = (method: string, value: unknown): RequestInit => ({
  method,
  body: JSON.stringify(value),
});

export type NodeDocument = {
  nodeId: string;
  path: string;
  body: string;
  raw: string;
  etag: string;
  frontmatter: Record<string, unknown>;
  version?: DocumentVersion;
  trustTier?: TrustTier;
};
/** Derived by Core from OKF `verified`: only a `human:` verifier makes a human review. */
export type TrustTier = "unverified" | "machine-confirmed" | "human-reviewed";
export type NodeEdit = {
  baseEtag: string;
  body?: string;
  frontmatter?: Record<string, unknown>;
};
export type SavedNode = {
  nodeId: string;
  path: string;
  etag: string;
  changed: boolean;
  body: string;
  version?: DocumentVersion;
  trustTier?: TrustTier;
};
export type CardSourceInput = { resource: string; title?: string; [key: string]: unknown };
/** Unsent browser input: its prompt, ordered sources and the lane it sits in (no target = the public area). */
export type CardInput = {
  prompt: string;
  title?: string;
  target: string | null;
  /** The Role the result comes back to; left out, receiving finishes the Card. */
  returnTo?: string;
  sources: CardSourceInput[];
};
/** A Card file as read back: the body text, its ETag and header fields. */
export type CardDocument = {
  cardId: string;
  path: string;
  etag: string;
  text: string;
  title?: string;
  target?: string;
  state: CardState;
  returnTo?: string;
  receivedBy?: string;
  result?: string;
  sources: CardSourceInput[];
};
export type SavedCard = { cardId: string; path: string; etag: string };

export const api = {
  /**
   * The first screen: each Node's name, type, place in the tree and explicit expiry, and the module lines.
   * Its revision covers only these and is never compared with the snapshot's.
   */
  map: () => call<WorkspaceMap>("/api/map"),
  /** Resolves to null when the snapshot still matches `revision`. */
  snapshot: (revision?: string) =>
    call<Snapshot | null>(
      "/api/snapshot",
      revision ? { headers: { "If-None-Match": `"${revision}"` } } : {},
    ),
  /** Rebuilds at the same revision: Card progress and completions follow materials outside Tent. */
  freshSnapshot: () => call<Snapshot>("/api/snapshot?fresh=1"),
  revision: () => call<{ revision: string }>("/api/revision"),
  /** The map's canvas file (`.tent/canvas.json`); both null while the file does not exist. */
  canvas: () => call<{ etag: string | null; canvas: unknown }>("/api/canvas"),
  /** Replaces the whole canvas file; a stale ETag is refused with the current file in the details. */
  saveCanvas: (baseEtag: string | null, canvas: unknown) =>
    call<{ etag: string }>("/api/canvas", send("PUT", { baseEtag, canvas })),
  /** Which Nodes with code directories import which, from the repository's current files. */
  /**
   * When each Node's body or material addresses last changed, and when each output was last recorded or
   * confirmed; null where history cannot show it. Confirmations and other metadata do not count.
   */
  nodeTimes: (ids: readonly string[]) =>
    call<{ nodeId: string; contentChangedAt: string | null; recordedAt: string | null }[]>(
      `/api/nodes/times?${ids.map((id) => `nodeId=${encodeURIComponent(id)}`).join("&")}`,
    ),
  /** Tests covering each Node that holds code, and what it often changes with; worked out on each read. */
  codeFacts: () => call<CodeFacts>("/api/modules/facts"),
  /** How each output stands to every goal above it, and what changed since it was written. */
  compareOutputs: (ids: readonly string[]) =>
    call<OutputComparison[]>(
      `/api/outputs/compare?${ids.map((id) => `nodeId=${encodeURIComponent(id)}`).join("&")}`,
    ),
  /** Ahead and behind Nodes, computed fresh: material changes do not move the revision. */
  sync: () => call<{ revision: string; nodes: SyncFlags }>("/api/sync"),
  node: (id: string, capture = false) =>
    call<NodeDocument>(`/api/nodes/${encodeURIComponent(id)}${capture ? "?capture=true" : ""}`),
  nodeHistory: (id: string) =>
    call<NodeHistoryDetails>(`/api/nodes/${encodeURIComponent(id)}/history`),
  nodeCards: (id: string) => call<NodeCardsDetails>(`/api/nodes/${encodeURIComponent(id)}/cards`),
  nodeRelations: (id: string, direction: "outgoing" | "incoming") =>
    call<NodeRelationsDetails>(
      `/api/nodes/${encodeURIComponent(id)}/relations?direction=${direction}`,
    ),
  saveNode: (id: string, edit: NodeEdit) =>
    wrote(call<SavedNode>(`/api/nodes/${encodeURIComponent(id)}`, send("PUT", edit))),
  /** Removes the Node and everything under it; referenced files and links pointing at it stay. */
  deleteNode: (id: string) =>
    wrote(call<{ nodeId: string }>(`/api/nodes/${encodeURIComponent(id)}`, send("DELETE", {}))),
  /** Marks the subtree deprecated; the returned commit is what restoring undoes. */
  archiveNode: (id: string) =>
    wrote(
      call<{ commit?: string }>(`/api/nodes/${encodeURIComponent(id)}/archive`, send("POST", {})),
    ),
  restoreNode: (id: string, archiveCommit: string) =>
    wrote(call(`/api/nodes/${encodeURIComponent(id)}/restore`, send("POST", { archiveCommit }))),
  /** A new Node under `parent`, or at the top for null. */
  createNode: (parent: string | null, name: string, type: string) =>
    wrote(call<{ nodeId: string }>("/api/nodes", send("POST", { parent, name, type }))),
  /** Into `parent` (null: the top), last, or before or after one of its children. */
  moveNode: (id: string, to: { parent: string | null; before?: string; after?: string }) =>
    wrote(call(`/api/nodes/${encodeURIComponent(id)}/move`, send("POST", to))),
  renameNode: (id: string, name: string) =>
    wrote(call(`/api/nodes/${encodeURIComponent(id)}/rename`, send("POST", { name }))),
  role: (id: string) => call<{ etag: string }>(`/api/roles/${encodeURIComponent(id)}`),
  /** A Role's lifecycle: archived is `status: deprecated`, restored drops the field. */
  setRoleArchived: (id: string, baseEtag: string, archived: boolean) =>
    wrote(
      call(`/api/roles/${encodeURIComponent(id)}/status`, send("POST", { baseEtag, archived })),
    ),
  /**
   * Removes the Role document for good. Unfinished Cards refuse with PENDING_CARDS, listing every one: pending
   * ones targeted to it, ones returning to it until collected, and ones it took and still owes a return.
   */
  deleteRole: (id: string, baseEtag: string) =>
    wrote(call(`/api/roles/${encodeURIComponent(id)}`, send("DELETE", { baseEtag }))),
  /** Withdraws a published Card through its lifecycle status; input and reception stay. */
  deprecateCard: (id: string, baseEtag: string) =>
    wrote(call(`/api/cards/${encodeURIComponent(id)}/deprecate`, send("POST", { baseEtag }))),
  card: (id: string) => call<CardDocument>(`/api/cards/${encodeURIComponent(id)}`),
  createCard: (input: CardInput) => wrote(call<SavedCard>("/api/cards", send("POST", input))),
  /**
   * A published Card changes lane or place until a Role receives it. A null target returns it to the public
   * area and a missing one keeps its lane; before or after puts it next to another waiting Card of that lane,
   * and without either it goes to the end.
   */
  moveCard: (id: string, baseEtag: string, to: CardMove) =>
    wrote(
      call<SavedCard>(
        `/api/cards/${encodeURIComponent(id)}/move`,
        send("POST", { baseEtag, ...to }),
      ),
    ),
  document: (version: DocumentVersion) =>
    call<{ raw: string }>(`/api/history/document?at=${at(version)}`),
  workspaces: () => call<{ workspaces: KnownWorkspace[] }>("/api/workspaces"),
  /** Starts or finds the service for another workspace; the page then goes to its address. */
  openWorkspace: (path: string) =>
    call<{ url: string; portTaken?: number }>("/api/workspaces/open", send("POST", { path })),
  diff: (from: DocumentVersion, to: DocumentVersion) =>
    call<{ text: string; pathChanged: boolean }>(`/api/history/diff?from=${at(from)}&to=${at(to)}`),
};

export type CardMove = { target?: string | null; before?: string; after?: string };

/** What `/api/files/info` says of each path: its size and time, or null when it is not there. */
export type FileInfo = { size: number; modifiedAt: string } | null;
export const fileInfo = (paths: string[]) =>
  call<{ files: Record<string, FileInfo | null> }>("/api/files/info", send("POST", { paths }));

/** The head of a text file a Node names; the service reads only those, and says when one goes on. */
export type NodeText = {
  path: string;
  size: number;
  modifiedAt: string;
  text: string;
  truncated: boolean;
};
export const nodeText = (id: string, workspacePath: string, signal?: AbortSignal) =>
  call<NodeText>(
    `/api/nodes/${encodeURIComponent(id)}/text?path=${encodeURIComponent(workspacePath)}`,
    { signal },
  );

/** A workspace file's bytes; <iframe>, <video> and <audio> cannot send the token themselves. */
export async function workspaceBlob(workspacePath: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(`/api/files?path=${encodeURIComponent(workspacePath)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (!response.ok) throw new ApiError(response.status, `HTTP_${response.status}`, workspacePath);
  return response.blob();
}

const images = new Map<string, Promise<string>>();
/** A workspace image as a blob URL; <img> cannot send the token itself. */
export function workspaceImage(workspacePath: string): Promise<string> {
  let url = images.get(workspacePath);
  if (!url) {
    url = (async () => {
      return URL.createObjectURL(await workspaceBlob(workspacePath));
    })();
    url.catch(() => images.delete(workspacePath));
    images.set(workspacePath, url);
  }
  return url;
}
