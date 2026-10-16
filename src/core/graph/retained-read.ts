import { createHash } from "node:crypto";
import { readOnlyFs, type FsAdapter } from "../store/adapter.js";
import { isHistoryDocument } from "../store/document-history.js";
import { documentHeader } from "./node-catalog.js";
import { CANVAS_PATH, isOperationalPath, SYSTEM_REGISTRY_FILES } from "../base/paths.js";

/** One read's exact byte comparison; no capture, baseline update or cache write. */
export async function uncapturedChecker(fs: FsAdapter) {
  const blobs =
    fs.history && (await fs.exists(".git"))
      ? await fs.history.documentBlobs()
      : new Map<string, string>();
  return (path: string, raw: string): boolean => {
    const blob = blobs.get(path);
    if (!blob) return true;
    const bytes = Buffer.from(raw, "utf8");
    return (
      createHash(blob.length === 64 ? "sha256" : "sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex") !== blob
    );
  };
}

/** Document-derived state uses HEAD; external material observations remain live. */
export async function retainedDocumentFs(fs: FsAdapter): Promise<FsAdapter> {
  const head = fs.history && (await fs.exists(".git")) ? await fs.history.currentCommit() : null;
  const documents = new Map(
    head
      ? [...(await fs.history!.readDirectory(head))].filter(([path]) => isHistoryDocument(path))
      : [],
  );
  const directories = new Map<string, Map<string, boolean>>([["", new Map()]]);
  for (const file of documents.keys()) {
    const parts = file.split("/");
    for (let index = 0; index < parts.length; index++) {
      const parent = parts.slice(0, index).join("/");
      const entries = directories.get(parent) ?? new Map<string, boolean>();
      entries.set(parts[index]!, index < parts.length - 1);
      directories.set(parent, entries);
    }
  }
  const retainedPath = (path: string) =>
    path === "" ||
    path === "cards" ||
    path === "roles" ||
    path.startsWith("cards/") ||
    path.startsWith("roles/") ||
    (!isOperationalPath(path) && !SYSTEM_REGISTRY_FILES.has(path) && path !== CANVAS_PATH);
  const read = async (path: string) => {
    if (!isHistoryDocument(path)) return fs.readFile(path);
    const raw = documents.get(path);
    if (raw === undefined)
      throw Object.assign(new Error(`No retained document: ${path}`), { code: "ENOENT" });
    return raw;
  };
  return new Proxy(readOnlyFs(fs), {
    get(target, key) {
      if (key === "invalidNodeEdits") return undefined;
      if (key === "readFile") return read;
      if (key === "readBinary")
        return async (path: string) =>
          isHistoryDocument(path) ? Buffer.from(await read(path), "utf8") : target.readBinary(path);
      if (key === "readFrontmatter")
        return async (path: string) => documentHeader(await read(path));
      if (key === "listDir")
        return async (path: string) =>
          retainedPath(path)
            ? [...(directories.get(path) ?? [])].map(([name, isDir]) => ({ name, isDir }))
            : target.listDir(path);
      if (key === "exists")
        return async (path: string) =>
          retainedPath(path) ? documents.has(path) || directories.has(path) : target.exists(path);
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
