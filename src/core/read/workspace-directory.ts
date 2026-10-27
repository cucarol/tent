import path from "node:path";
import { fileURLToPath } from "node:url";

export type DirectoryEntry = {
  name: string;
  path: string;
  kind: "directory" | "file";
  size: number;
  modifiedAt: string;
};
export type WorkspaceDirectory = {
  path: string;
  parent: string | null;
  entries: DirectoryEntry[];
};

/** UI browsing stays inside this Workspace, including absolute file: links into it. */
export function workspaceNavigationPath(address: string, root: string): string {
  let relative = address;
  if (/^file:/i.test(address)) {
    const uri = new URL(address);
    if (uri.search || uri.hash)
      throw new Error("Directory links cannot select a query or fragment");
    relative = path.relative(root, fileURLToPath(uri)).split(path.sep).join("/");
  }
  if (
    path.isAbsolute(relative) ||
    /[\\\0:]/.test(relative) ||
    (relative !== "" &&
      relative
        .split("/")
        .some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git"))
  )
    throw new Error("Only paths inside the workspace outside .git can be browsed");
  return relative;
}

// Names read the way a person scans a folder: case folded and numbers by value, so B2 sits between a and
// b10. Names equal under that rule keep a fixed byte order, so the listing never depends on read order.
const byName = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const nameOrder = (a: string, b: string) => byName.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

/** A single observed level, with no traversal or material observation. */
export function workspaceDirectory(path: string, entries: DirectoryEntry[]): WorkspaceDirectory {
  return {
    path,
    parent: path ? path.split("/").slice(0, -1).join("/") : null,
    entries: entries
      .filter((entry) => entry.name.toLowerCase() !== ".git")
      .sort((a, b) =>
        a.kind !== b.kind ? (a.kind === "directory" ? -1 : 1) : nameOrder(a.name, b.name),
      ),
  };
}
