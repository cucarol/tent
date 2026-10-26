import { createContext, useContext, useEffect, useState } from "react";
import { fileInfo, type FileInfo } from "./api.js";
import type { Snapshot, SnapshotMaterial, SnapshotNode } from "./types.js";

/**
 * How the page shows a Node's own file: by the suffix of its `resource`, never by its type or tags. A
 * Node is not a kind of file; a file is what its resource points at.
 */
export type FileKind = "html" | "image" | "pdf" | "video" | "audio" | "text" | "other";

const KINDS: [RegExp, FileKind][] = [
  [/\.html?$/i, "html"],
  [/\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i, "image"],
  [/\.pdf$/i, "pdf"],
  [/\.(mp4|webm)$/i, "video"],
  [/\.(mp3|wav)$/i, "audio"],
  // Markdown and code keep the page as it was: the Node's own text, with the path among its properties.
  [
    /\.(md|markdown|mdx|txt|json|jsonc|ya?ml|toml|ini|csv|tsv|xml|[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|ps1|bat|sql|css|scss|less|vue|svelte|lua|r|dart|scala|zig)$/i,
    "text",
  ],
];
const filenameKind = (name: string): FileKind =>
  KINDS.find(([suffix]) => suffix.test(name))?.[1] ?? "other";
export const fileKind = (resource: string): FileKind => filenameKind(resource.split(/[?#]/)[0]!);

export type NodeFile =
  | { kind: "file"; path: string; name: string; ext: string; show: FileKind }
  | { kind: "uri"; uri: string };

/** The file or remote address a Node's `resource` names, if it names one. */
export function fileOf(node: SnapshotNode): NodeFile | null {
  const own = node.materials.find((m) => m.field === "resource");
  if (own?.kind === "uri" && own.uri) return { kind: "uri", uri: own.uri };
  return own ? localFile(own) : null;
}

function localFile(m: SnapshotMaterial): Extract<NodeFile, { kind: "file" }> | null {
  if (m.kind !== "file" || !m.workspacePath) return null;
  // A folder (written with a closing slash) is where the Node's code lives, not a file it can show.
  if (m.resource.split(/[?#]/)[0]!.endsWith("/")) return null;
  const path = m.workspacePath;
  return localFileAt(path);
}

/** The same suffix-driven preview for a file opened from a directory. */
export function localFileAt(path: string): Extract<NodeFile, { kind: "file" }> {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return {
    kind: "file",
    path,
    name,
    ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : "",
    show: filenameKind(name),
  };
}

/** The local files a Node names, its resource first and then its sources in order, each once. */
export function filesOf(
  node: SnapshotNode,
): { file: Extract<NodeFile, { kind: "file" }>; source?: number }[] {
  const seen = new Set<string>();
  return node.materials
    .filter((m) => m.field === "resource" || m.field === "sources")
    .sort((a, b) => (a.field === "resource" ? -1 : b.field === "resource" ? 1 : 0))
    .flatMap((m) => {
      const file = localFile(m);
      if (!file || seen.has(file.path)) return [];
      seen.add(file.path);
      return [m.field === "sources" ? { file, source: (m.index ?? 0) + 1 } : { file }];
    });
}

/** Workspace paths of every Node's own file, in the order the snapshot lists them. */
export const filePaths = (snapshot: Snapshot) => [
  ...new Set(
    snapshot.nodes.flatMap((n) => {
      const f = fileOf(n);
      return f?.kind === "file" ? [f.path] : [];
    }),
  ),
];

/** Size and time of each Node file; a path with null is missing, one not listed is not known yet. */
export type Files = Record<string, FileInfo | null>;
export const FilesContext = createContext<Files>({});
export const useFiles = () => useContext(FilesContext);

/** One file's info, read from the map's own keys: a file may be named `__proto__`. */
export const infoOf = (files: Files, path: string): FileInfo | null | undefined =>
  Object.prototype.hasOwnProperty.call(files, path) ? files[path] : undefined;

/**
 * Reads file sizes for the snapshot's files, again when the revision moves and when the page comes back
 * into view: a file deleted outside Tent changes no revision.
 */
export function useFileInfo(snapshot: Snapshot | null): Files {
  return useFileInfoRead(snapshot).files;
}

/** Retains the last display, while identifying whether this observation has returned its own result. */
export function useFileInfoRead(snapshot: Snapshot | null): { files: Files; current: boolean } {
  const [read, setRead] = useState<{ key: string; files: Files } | null>(null);
  const [looked, setLooked] = useState(0);
  useEffect(() => {
    const again = () => !document.hidden && setLooked((n) => n + 1);
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, []);
  const paths = snapshot ? filePaths(snapshot) : [];
  const key = JSON.stringify([paths, snapshot?.workspace.id, snapshot?.workspace.revision, looked]);
  useEffect(() => {
    if (!paths.length) return setRead({ key, files: {} });
    let live = true;
    fileInfo(paths).then(
      (result) => live && setRead({ key, files: result.files }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [key]);
  return { files: read?.files ?? {}, current: read?.key === key };
}

/** Larger files are listed, not loaded into the page; the service holds the same limits. */
const MB = 1024 * 1024;
export const fileLimit = (show: FileKind) =>
  show === "video" || show === "audio" ? 200 * MB : 20 * MB;

/**
 * What a card can open under itself, as a Markdown note embeds it: a local file that is there and small
 * enough, of any kind but the ones the browser cannot show.
 */
export function previewOf(
  node: SnapshotNode,
  files: Files,
): Extract<NodeFile, { kind: "file" }> | null {
  const file = fileOf(node);
  if (file?.kind !== "file" || file.show === "other") return null;
  const info = infoOf(files, file.path);
  return info && info.size <= fileLimit(file.show) ? file : null;
}

/** Markdown is shown as the page reads it; other text as it is written. */
export const isMarkdown = (file: { ext: string }) => /^(md|markdown|mdx)$/.test(file.ext);

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let n = bytes / 1024;
  let i = 0;
  for (; n >= 1024 && i < units.length - 1; i++) n /= 1024;
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}
