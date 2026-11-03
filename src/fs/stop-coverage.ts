import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { NodeFs } from "./node-fs.js";
import { loadNodeCatalog } from "../core/graph/node-catalog.js";
import { buildStopCoverageIndex, type StopCoverageIndex } from "../core/return/stop-coverage.js";
import { isValidTentIndexMarker } from "../core/store/scaffold.js";
import { MUTATION_LOCK_PATH } from "../core/base/paths.js";
import { TRANSACTION_PATH } from "../core/store/file-transaction.js";
import { withFileMutationLock } from "./mutation-lock.js";
import { fileState, isFileState, stateCacheHit, type FileState } from "./file-state-cache.js";

type Header = { content: string; state: FileState };
type Cache = { writtenAtNs: string; headers: Array<[string, Header]> };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function readCache(filename: string): Promise<Cache | undefined> {
  try {
    const raw = JSON.parse(await fs.readFile(filename, "utf8"));
    if (raw.schema !== 1 || !/^\d+$/.test(raw.writtenAtNs) || !Array.isArray(raw.headers)) return;
    if (raw.digest !== digest([raw.writtenAtNs, raw.headers])) return;
    if (
      !raw.headers.every((row: unknown) => {
        if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== "string") return false;
        const header = row[1] as Partial<Header> | null;
        return header !== null && typeof header?.content === "string" && isFileState(header.state);
      })
    )
      return;
    return { writtenAtNs: raw.writtenAtNs, headers: raw.headers };
  } catch {
    return undefined;
  }
}

/** Scan only the Node topology and its headers. No repository or source population is observed. */
export async function loadStopCoverage(
  systemRoot: string,
  workspaceRoot: string,
  adapter?: NodeFs,
): Promise<StopCoverageIndex> {
  const source = adapter ?? new NodeFs(systemRoot);
  try {
    return await source.observationScope(
      () =>
        withFileMutationLock(
          path.join(systemRoot, MUTATION_LOCK_PATH),
          async () => {
            await fs.access(path.join(systemRoot, TRANSACTION_PATH)).then(
              () => {
                throw new Error("Tent transaction is pending");
              },
              (error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
              },
            );
            if (
              !isValidTentIndexMarker(await fs.readFile(path.join(systemRoot, "index.md"), "utf8"))
            )
              throw new Error("Invalid Tent index marker");
            const cacheFile = path.join(
              systemRoot,
              ".git",
              "tent-material-cache",
              "stop-coverage.json",
            );
            const previous = await readCache(cacheFile);
            const oldHeaders = new Map(previous?.headers);
            const headers = new Map<string, Header>();
            const writtenAtNs = String(BigInt(Date.now()) * 1_000_000n);
            const snapshot = new Proxy(source, {
              get(target, key) {
                // The outer scope already disabled prepared repository/graph observations.
                if (key === "observationScope") return (action: () => Promise<unknown>) => action();
                if (key === "readFrontmatter")
                  return async (filename: string) => {
                    const state = fileState(
                      await fs.stat(path.join(systemRoot, filename), { bigint: true }),
                    );
                    const cached = oldHeaders.get(filename);
                    const observed =
                      previous && cached && stateCacheHit(state, cached.state, previous.writtenAtNs)
                        ? { content: cached.content, state }
                        : await target.readFrontmatterObservation(filename);
                    headers.set(filename, observed);
                    return observed.content;
                  };
                const value = Reflect.get(target, key);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
            const index = buildStopCoverageIndex(
              await loadNodeCatalog(snapshot),
              systemRoot,
              workspaceRoot,
            );
            const records = [...headers].sort(([left], [right]) => left.localeCompare(right));
            const temp = `${cacheFile}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
            try {
              // A cache is optional. Do not create a history store merely to cache headers.
              if ((await fs.stat(path.join(systemRoot, ".git"))).isDirectory()) {
                await fs.mkdir(path.dirname(cacheFile), { recursive: true });
                await fs.writeFile(
                  temp,
                  JSON.stringify({
                    schema: 1,
                    writtenAtNs,
                    headers: records,
                    digest: digest([writtenAtNs, records]),
                  }),
                );
                await fs.rename(temp, cacheFile);
              }
            } catch {
              await fs.rm(temp, { force: true }).catch(() => undefined);
            }
            return index;
          },
          {
            waitMs: 8_000,
            busyMessage:
              "Tent mutation lock is still busy after waiting 8 seconds; wait for the other write to finish, then reread before retrying.",
            acquireFailedMessage: "Cannot acquire the Tent mutation lock.",
          },
        ),
      { forceContent: true },
    );
  } finally {
    if (!adapter) await source.close();
  }
}
