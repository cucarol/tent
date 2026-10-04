// Client for the `tent ui` service (contract: Tent Node "Web界面服务接口").
// The token arrives once in the URL fragment and is kept for this tab only.
import { t } from "../i18n.js";
import type { DocumentVersion, Snapshot } from "./types.js";

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
};
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
};
export type CardSourceInput = { resource: string; title?: string; [key: string]: unknown };
/** What a draft holds: its prompt, ordered sources and the lane it sits in (no target = the public area). */
export type DraftInput = {
  prompt: string;
  title?: string;
  target: string | null;
  sources: CardSourceInput[];
};
/** A Card file as read back: the body text, its ETag and header fields. */
export type CardDocument = {
  cardId: string;
  path: string;
  etag: string;
  text: string;
  draft: boolean;
  title?: string;
  target?: string;
  state: "pending" | "consumed" | "interrupted";
  receivedBy?: string;
  sources: CardSourceInput[];
};
export type SavedCard = { cardId: string; path: string; etag: string };

export const api = {
  hasToken: () => !!token,
  /** Resolves to null when the snapshot still matches `revision`. */
  snapshot: (revision?: string) =>
    call<Snapshot | null>(
      "/api/snapshot",
      revision ? { headers: { "If-None-Match": `"${revision}"` } } : {},
    ),
  revision: () => call<{ revision: string }>("/api/revision"),
  node: (id: string, capture = false) =>
    call<NodeDocument>(`/api/nodes/${encodeURIComponent(id)}${capture ? "?capture=true" : ""}`),
  saveNode: (id: string, edit: NodeEdit) =>
    wrote(call<SavedNode>(`/api/nodes/${encodeURIComponent(id)}`, send("PUT", edit))),
  card: (id: string) => call<CardDocument>(`/api/cards/${encodeURIComponent(id)}`),
  /** Drafts live in the workspace without publication history; `card take` refuses them. */
  createDraft: (draft: DraftInput) =>
    wrote(call<SavedCard>("/api/cards/drafts", send("POST", draft))),
  saveDraft: (id: string, baseEtag: string, draft: DraftInput) =>
    wrote(
      call<SavedCard>(`/api/cards/${encodeURIComponent(id)}`, send("PUT", { ...draft, baseEtag })),
    ),
  deleteDraft: (id: string, baseEtag: string) =>
    wrote(call<SavedCard>(`/api/cards/${encodeURIComponent(id)}`, send("DELETE", { baseEtag }))),
  /** Pins the sources, records the Card in history and fixes its prompt and sources. */
  publishCard: (id: string, baseEtag: string) =>
    wrote(
      call<SavedCard>(`/api/cards/${encodeURIComponent(id)}/publish`, send("POST", { baseEtag })),
    ),
  /** A published Card changes lane until a Role receives it; null returns it to the public area. */
  moveCard: (id: string, baseEtag: string, target: string | null) =>
    wrote(
      call<SavedCard>(
        `/api/cards/${encodeURIComponent(id)}/move`,
        send("POST", { baseEtag, target }),
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

const images = new Map<string, Promise<string>>();
/** A workspace image as a blob URL; <img> cannot send the token itself. */
export function workspaceImage(workspacePath: string): Promise<string> {
  let url = images.get(workspacePath);
  if (!url) {
    url = (async () => {
      const response = await fetch(`/api/files?path=${encodeURIComponent(workspacePath)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok)
        throw new ApiError(response.status, `HTTP_${response.status}`, workspacePath);
      return URL.createObjectURL(await response.blob());
    })();
    url.catch(() => images.delete(workspacePath));
    images.set(workspacePath, url);
  }
  return url;
}
