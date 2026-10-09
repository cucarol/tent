import { createContext, useContext, useEffect, useState } from "react";
import { fileInfo, type FileInfo } from "./api.js";
import type { Snapshot, SnapshotNode, SyncFlags } from "./types.js";

/**
 * How the page shows a Node's own file: by the suffix of its `resource`, never by its type or tags. A
 * Node is not a kind of file; a file is what its resource points at.
 */
export type FileKind = "html" | "image" | "video" | "audio" | "text" | "other";

const KINDS: [RegExp, FileKind][] = [
  [/\.html?$/i, "html"],
  [/\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i, "image"],
  [/\.(mp4|webm)$/i, "video"],
  [/\.(mp3|wav)$/i, "audio"],
  // Markdown and code keep the page as it was: the Node's own text, with the path among its properties.
  [
    /\.(md|markdown|mdx|txt|json|jsonc|ya?ml|toml|ini|csv|tsv|xml|[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|ps1|bat|sql|css|scss|less|vue|svelte|lua|r|dart|scala|zig)$/i,
    "text",
  ],
];
export const fileKind = (resource: string): FileKind =>
  KINDS.find(([suffix]) => suffix.test(resource.split(/[?#]/)[0]!))?.[1] ?? "other";

export type NodeFile =
  | { kind: "file"; path: string; name: string; ext: string; show: FileKind }
  | { kind: "uri"; uri: string };

/** The file or remote address a Node's `resource` names, if it names one. */
export function fileOf(node: SnapshotNode): NodeFile | null {
  const own = node.materials.find((m) => m.field === "resource");
  if (own?.kind === "uri" && own.uri) return { kind: "uri", uri: own.uri };
  if (own?.kind !== "file" || !own.workspacePath) return null;
  const path = own.workspacePath;
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return {
    kind: "file",
    path,
    name,
    ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : "",
    show: fileKind(name),
  };
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
 * Reads file sizes for the snapshot's files, again when the revision moves and when the flags are
 * reread: a file deleted outside Tent changes no revision, but the flags follow it.
 */
export function useFileInfo(snapshot: Snapshot | null, flags: SyncFlags): Files {
  const [files, setFiles] = useState<Files>({});
  const paths = snapshot ? filePaths(snapshot) : [];
  const key = paths.join("\n");
  useEffect(() => {
    if (!paths.length) return setFiles({});
    let live = true;
    fileInfo(paths).then(
      (result) => live && setFiles(result.files),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [key, snapshot?.workspace.revision, flags]);
  return files;
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let n = bytes / 1024;
  let i = 0;
  for (; n >= 1024 && i < units.length - 1; i++) n /= 1024;
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}
