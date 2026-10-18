import { execFile } from "node:child_process";
import path from "node:path";
import {
  materialLocator,
  localMaterialPath,
  isDirectoryMaterial,
  isPrefixMaterial,
} from "../core/base/material.js";
import { checkedSourceFile } from "./checked-source-file.js";
import { directoryRepository } from "./repository-material.js";

/** Read only the owning checkout's index, never filters, network objects or a retained blob. */
export async function materialIsTracked(
  workspaceRoot: string,
  resource: string,
  documentPath: string,
) {
  const locator = materialLocator(resource, documentPath, true);
  const filename = localMaterialPath(locator, workspaceRoot);
  if (!filename || isDirectoryMaterial(locator) || isPrefixMaterial(locator)) return undefined;
  await checkedSourceFile(
    locator.kind === "uri" ? path.parse(filename).root : workspaceRoot,
    filename,
  );
  const repo = await directoryRepository(path.dirname(filename));
  if (!repo) return false;
  const relative = path.relative(repo.root, filename).split(path.sep).join("/");
  return new Promise<boolean>((resolve, reject) => {
    execFile(
      "git",
      [
        "--no-optional-locks",
        "--no-lazy-fetch",
        "-c",
        "core.fsmonitor=false",
        "-C",
        repo.root,
        "ls-files",
        "--cached",
        "-z",
        "--",
        `:(${process.platform === "win32" ? "icase," : ""}literal)${relative}`,
      ],
      {
        windowsHide: true,
        encoding: "buffer",
        maxBuffer: 1024 * 1024,
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
        ),
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout.length > 0)),
    );
  });
}
