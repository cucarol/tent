// node:fs 实现的 FsAdapter。给 CLI(skill 调用)和测试用。

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import type { FsAdapter, Clock } from "../core/store/adapter.js";
import { withFileMutationLock } from "./mutation-lock.js";
import { constants } from "node:fs";
import { checkedSourceFile } from "./checked-source-file.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { GitDocumentHistory, type CaptureMetadata } from "../core/store/git-history.js";
import { isHistoryDocument, isHistoryFile } from "../core/store/document-history.js";
import { renameWithRetry } from "./rename-with-retry.js";
import { observeMaterialResource } from "./source-observation.js";
import { withStructureSnapshot, withoutStructureSnapshot } from "./structure-observation.js";
import { workspaceRootFromSystemRoot } from "../core/base/paths.js";
import {
  prepareNodeSyncSave,
  relocateNodeRecord,
  retainedNodeRecords,
} from "../core/graph/node-sync-record.js";
import { parseFrontmatter } from "../core/base/frontmatter.js";
import { loadNodeCatalog } from "../core/graph/node-catalog.js";
import { materialLocator } from "../core/base/material.js";
import { assertSystemMaterial } from "../core/graph/material-target.js";
import { materialIsTracked } from "./material-tracking.js";
import { createHash } from "node:crypto";
import { documentHeader } from "../core/graph/node-catalog.js";
import {
  cachedFileValue,
  fileState,
  sameFileState,
  withFileReadScope,
  withoutFileReadScope,
  scopedRead,
  peekScopedRead,
  rememberFileValue,
  forgetScopedReads,
  forgetScopedRead,
  hasFileReadScope,
  type FileState,
} from "./file-state-cache.js";
import { withDocumentHeaderCache } from "./document-header-cache.js";

type ObservedBytes = { bytes: Buffer; state: FileState };
type ObservedPrefix = { header: string; state: FileState; bytes?: Buffer };

export class NodeFs implements FsAdapter {
  private root: string;
  readonly workspaceRoot: string | undefined;
  invalidNodeEdits?: ReadonlyMap<string, string>;
  readonly history: GitDocumentHistory;
  private historyWrites = new AsyncLocalStorage<Map<string, string | null>>();
  private historyPreimages = new AsyncLocalStorage<Map<string, string | null>>();

  constructor(
    root: string,
    private readonly entry: CaptureMetadata["entry"] = "core",
  ) {
    this.root = nodePath.resolve(root);
    this.workspaceRoot = workspaceRootFromSystemRoot(this.root);
    this.history = new GitDocumentHistory(this.root, entry);
  }

  observationScope<T>(action: () => Promise<T>, options?: { forceContent?: boolean }): Promise<T> {
    if (hasFileReadScope() && !options?.forceContent) return withStructureSnapshot(action);
    return withFileReadScope(
      () =>
        withDocumentHeaderCache(this.root, () =>
          withStructureSnapshot(action, options?.forceContent),
        ),
      options?.forceContent,
    );
  }

  private readCacheFile(): Promise<string | undefined> {
    return scopedRead(`cache-location:${this.root}`, async () =>
      (await this.exists(".git"))
        ? this.abs(".git/tent-material-cache/file-state.json")
        : undefined,
    );
  }

  async materialIsTracked(resource: string, documentPath: string) {
    return this.workspaceRoot
      ? materialIsTracked(this.workspaceRoot, resource, documentPath)
      : undefined;
  }

  async observeMaterial(
    resource: string,
    documentPath: string,
    track?: "structure",
    structureResources?: readonly string[],
  ) {
    const workspaceRoot = workspaceRootFromSystemRoot(this.root);
    if (!workspaceRoot) throw new Error("Material observation requires a Workspace .tent root");
    await assertSystemMaterial(this, materialLocator(resource, documentPath, true));
    const cacheDir = (await this.exists(".git")) ? this.abs(".git/tent-material-cache") : undefined;
    const observed = await observeMaterialResource(
      workspaceRoot,
      documentPath,
      resource,
      cacheDir,
      track,
      structureResources,
    );
    const relative = nodePath.relative(this.root, observed.canonicalPath);
    const inside =
      relative !== ".." &&
      !relative.startsWith(`..${nodePath.sep}`) &&
      !nodePath.isAbsolute(relative);
    const systemPath = inside ? relative.split(nodePath.sep).join("/") : undefined;
    return {
      ...observed,
      ...(systemPath ? { systemPath } : {}),
    };
  }

  private abs(p: string): string {
    // Tent paths use "/". Treat "\" as a separator everywhere, so a path that
    // escapes on Windows also escapes on POSIX instead of naming one odd file.
    const resolved = nodePath.resolve(this.root, p.replace(/\\/g, "/"));
    const root = process.platform === "win32" ? this.root.toLowerCase() : this.root;
    const candidate = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (candidate !== root && !candidate.startsWith(root + nodePath.sep)) {
      throw new Error(`Path escapes Tent root: ${p}`);
    }
    return resolved;
  }

  async listDir(dir: string): Promise<{ name: string; isDir: boolean }[]> {
    return scopedRead(`directory:${this.abs(dir)}`, async () => {
      const entries = await fs.readdir(this.abs(dir), { withFileTypes: true });
      return entries
        .filter((e) => !e.name.startsWith(".git"))
        .map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    });
  }

  async readFile(path: string): Promise<string> {
    return (await this.readBytes(path, false)).bytes.toString("utf8");
  }

  async readFrontmatter(path: string): Promise<string> {
    return (await this.readFrontmatterObservation(path)).content;
  }

  /** A derived cache must retain the identity of the observation that supplied its content. */
  async readFrontmatterObservation(path: string): Promise<{ content: string; state: FileState }> {
    return withFileReadScope(() =>
      scopedRead(`header:${this.abs(path)}`, async () => {
        const full = peekScopedRead<ObservedBytes>(`bytes:${this.abs(path)}`);
        if (full) {
          const { bytes, state } = await full;
          try {
            return { content: documentHeader(bytes.toString("utf8")), state };
          } catch {
            return { content: bytes.toString("utf8"), state };
          }
        }
        const prefix = await scopedRead(`prefix-bytes:${this.abs(path)}`, () =>
          this.readPrefix(path),
        );
        return { content: prefix.header, state: prefix.state };
      }),
    );
  }

  private async readPrefix(path: string): Promise<ObservedPrefix> {
    const state = fileState(await fs.stat(this.abs(path), { bigint: true }));
    const cache = await this.readCacheFile();
    const key = `header:${this.abs(path)}`;
    const cached = await cachedFileValue(
      cache,
      key,
      state,
      (value): value is string => typeof value === "string",
    );
    if (cached !== undefined) return { header: cached, state };
    const { header, bytes } = await this.readFrontmatterUncached(path, state);
    const after = fileState(await fs.stat(this.abs(path), { bigint: true }));
    if (!sameFileState(state, after)) throw new Error("Source changed while reading header");
    await rememberFileValue(cache, key, state, header);
    return { header, bytes, state };
  }

  private async readFrontmatterUncached(
    path: string,
    expected: FileState,
  ): Promise<{ header: string; bytes: Buffer; complete: boolean }> {
    const handle = await fs.open(this.abs(path), "r");
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    const chunk = Buffer.alloc(4096);
    const opening = /^(\uFEFF)?---[\t ]*(\r?\n)/;
    const fence = /^---[\t ]*(?:\r?\n|$)/gm;
    let raw = "";
    let openingEnd = -1;
    let searchFrom = 0;
    const chunks: Buffer[] = [];
    try {
      // Path stats can both see the original file after a directory is swapped
      // out and restored. Bind the bytes to the handle actually opened as well.
      const opened = fileState(await handle.stat({ bigint: true }));
      if (!sameFileState(opened, expected)) throw new Error("Source changed while reading header");
      const finish = async (header: string, complete: boolean) => {
        if (!sameFileState(fileState(await handle.stat({ bigint: true })), opened))
          throw new Error("Source changed while reading header");
        return { header, bytes: Buffer.concat(chunks), complete };
      };
      while (true) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        const eof = bytesRead === 0;
        if (bytesRead) chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
        raw += decoder.decode(chunk.subarray(0, bytesRead), { stream: !eof });

        if (openingEnd < 0) {
          const match = opening.exec(raw);
          if (match) {
            openingEnd = match[0].length;
            searchFrom = openingEnd;
          } else if (eof || !/^(?:\uFEFF)?(?:-{0,2}|---[\t ]*\r?)$/.test(raw)) {
            return await finish("", eof);
          } else {
            continue;
          }
        }

        fence.lastIndex = searchFrom;
        const closing = fence.exec(raw);
        if (closing) {
          const end = closing.index + closing[0].length;
          // A match at the buffer edge may be a partial CRLF or fence line.
          if (
            eof ||
            closing[0].endsWith("\n") ||
            (end < raw.length && !(raw[end] === "\r" && end === raw.length - 1))
          ) {
            return await finish(raw.slice(0, end), eof);
          }
          searchFrom = closing.index;
        } else {
          // Recheck the unfinished line after the next chunk, including a split fence.
          searchFrom =
            Math.max(
              raw.lastIndexOf("\n"),
              raw.lastIndexOf("\r"),
              raw.lastIndexOf("\u2028"),
              raw.lastIndexOf("\u2029"),
              openingEnd - 1,
            ) + 1;
        }
        if (eof) return await finish(raw, true);
      }
    } finally {
      await handle.close();
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    forgetScopedReads();
    const abs = this.abs(path);
    const tracked = await this.beforeHistoryChange([path]);
    await fs.mkdir(nodePath.dirname(abs), { recursive: true });
    await this.atomicReplace(abs, content, "utf8");
    if (tracked && isHistoryFile(path)) tracked.set(path, content);
  }

  async readBinary(path: string): Promise<Uint8Array> {
    const candidate = this.abs(path);
    await checkedSourceFile(this.root, candidate);
    return (await this.readBytes(path, true)).bytes;
  }

  private async readBytes(path: string, checked: boolean): Promise<ObservedBytes> {
    const key = `bytes:${this.abs(path)}`;
    const previous = peekScopedRead<ObservedBytes>(key);
    if (previous) {
      const observed = await previous;
      const current = fileState(await fs.stat(this.abs(path), { bigint: true }));
      if (sameFileState(observed.state, current)) return observed;
      // Core rereads documents to detect conflicts. A request-local snapshot must
      // not turn that recheck into a comparison with its own earlier bytes.
      forgetScopedRead(key);
    }
    return scopedRead(key, () =>
      this.readBytesUncached(
        path,
        checked,
        peekScopedRead<ObservedPrefix>(`prefix-bytes:${this.abs(path)}`),
      ),
    );
  }

  private async readBytesUncached(
    path: string,
    checked: boolean,
    pendingPrefix?: Promise<ObservedPrefix>,
  ): Promise<ObservedBytes> {
    const candidate = this.abs(path);
    if (checked) await checkedSourceFile(this.root, candidate);
    const handle = await fs.open(
      candidate,
      checked
        ? constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
        : "r",
    );
    try {
      const before = await handle.stat({ bigint: true }),
        current = checked ? await checkedSourceFile(this.root, candidate, false, true) : undefined;
      if (current && (before.dev !== current.dev || before.ino !== current.ino))
        throw new Error("Source changed while opening");
      const prefix = await pendingPrefix;
      let buf: Buffer;
      if (prefix?.bytes && sameFileState(prefix.state, fileState(before))) {
        const rest = Buffer.alloc(Number(before.size) - prefix.bytes.length);
        let offset = 0;
        while (offset < rest.length) {
          const { bytesRead } = await handle.read(
            rest,
            offset,
            rest.length - offset,
            prefix.bytes.length + offset,
          );
          if (!bytesRead) throw new Error("Source truncated while reading");
          offset += bytesRead;
        }
        buf = Buffer.concat([prefix.bytes, rest]);
      } else buf = await handle.readFile();
      const after = await handle.stat({ bigint: true }),
        final = checked
          ? await checkedSourceFile(this.root, candidate, false, true)
          : await fs.stat(candidate, { bigint: true });
      if (
        BigInt(buf.length) !== before.size ||
        !sameFileState(fileState(after), fileState(before)) ||
        final.dev !== before.dev ||
        final.ino !== before.ino
      )
        throw new Error("Source changed while reading");
      return { bytes: buf, state: fileState(before) };
    } finally {
      await handle.close();
    }
  }

  async readContentDigest(path: string): Promise<{ size: number; digest: string }> {
    return withFileReadScope(() =>
      scopedRead(`digest:${this.abs(path)}`, async () => {
        await checkedSourceFile(this.root, this.abs(path));
        const state = fileState(await fs.stat(this.abs(path), { bigint: true }));
        const cache = await this.readCacheFile();
        const key = `digest:${this.abs(path)}`;
        const cached = await cachedFileValue(
          cache,
          key,
          state,
          (value): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
        );
        if (cached !== undefined) return { size: Number(state.size), digest: cached };
        const { bytes, state: observed } = await this.readBytes(path, true);
        const digest = createHash("sha256").update(bytes).digest("hex");
        await rememberFileValue(cache, key, observed, digest);
        return { size: bytes.length, digest };
      }),
    );
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    forgetScopedReads();
    const abs = this.abs(path);
    const tracked = await this.beforeHistoryChange([path]);
    await fs.mkdir(nodePath.dirname(abs), { recursive: true });
    const payload = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    await this.atomicReplace(abs, payload);
    if (tracked && isHistoryFile(path))
      tracked.set(path, new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(payload));
  }

  private async atomicReplace(
    abs: string,
    data: string | Uint8Array,
    encoding?: BufferEncoding,
  ): Promise<void> {
    const tmp = `${abs}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await fs.writeFile(tmp, data, encoding);
      await renameWithRetry(tmp, abs);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fs.access(this.abs(path));
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(path: string): Promise<void> {
    await fs.mkdir(this.abs(path), { recursive: true });
  }

  async move(from: string, to: string): Promise<void> {
    forgetScopedReads();
    const files = this.historyWrites.getStore() ? await this.filesUnder(from) : [];
    const targets = files.map((file) => to + file.slice(from.length));
    const tracked = await this.beforeHistoryChange([...files, ...targets]);
    await fs.mkdir(nodePath.dirname(this.abs(to)), { recursive: true });
    await fs.rename(this.abs(from), this.abs(to));
    if (tracked)
      for (let i = 0; i < files.length; i++) {
        if (isHistoryFile(files[i]!)) tracked.set(files[i]!, null);
        if (isHistoryFile(targets[i]!)) tracked.set(targets[i]!, await this.readFile(targets[i]!));
      }
  }

  async remove(path: string): Promise<void> {
    forgetScopedReads();
    const files = this.historyWrites.getStore() ? await this.filesUnder(path) : [];
    const tracked = await this.beforeHistoryChange(files);
    await fs.rm(this.abs(path), { recursive: true, force: true });
    if (tracked) for (const file of files) if (isHistoryFile(file)) tracked.set(file, null);
  }

  async removeEmptyDir(path: string): Promise<void> {
    await fs.rmdir(this.abs(path));
  }

  /** List the independent Tent Git HEAD tree without reading blobs or writing caches. */
  async retainedDocumentPaths(): Promise<string[] | undefined> {
    if (!(await this.exists(".git"))) return undefined;
    const head = await this.history.currentCommit();
    if (!head) return [];
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
    );
    const stdout = await new Promise<string>((resolve, reject) =>
      execFile(
        "git",
        [
          `--git-dir=${nodePath.join(this.root, ".git")}`,
          "ls-tree",
          "-r",
          "--name-only",
          "-z",
          head,
        ],
        { env, windowsHide: true, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
        (error, output) => (error ? reject(error) : resolve(output)),
      ),
    );
    return stdout.split("\0").filter(Boolean);
  }

  async withDocumentHistory<T>(action: () => Promise<T>, metadata?: CaptureMetadata): Promise<T> {
    if (!(await this.exists(".git"))) return action();
    return this.history.withDeferredIndexMirror(() => this.recordDocumentChanges(action, metadata));
  }

  private async recordDocumentChanges<T>(
    action: () => Promise<T>,
    metadata?: CaptureMetadata,
  ): Promise<T> {
    return this.historyPreimages.run(new Map(), () =>
      this.historyWrites.run(new Map(), async () => {
        const result = await action();
        const changes = [...this.historyWrites.getStore()!].map(([path, raw]) => ({ path, raw }));
        try {
          for (const change of changes) {
            const current = await this.readFile(change.path).catch((error) => {
              if (error.code === "ENOENT") return null;
              throw error;
            });
            if (current !== change.raw)
              throw new Error(`Document changed during save: ${change.path}`);
          }
          if (changes.length) {
            const nodeRecords = { ...metadata?.nodeRecords };
            if (metadata?.operation === "node.move" || metadata?.operation === "node.rename") {
              const nodes = (await loadNodeCatalog(this)).byId,
                beforeNodes = new Map(nodes),
                retained = await retainedNodeRecords(this);
              const originals = new Map<string, { path: string; raw: string }>();
              for (const [path, raw] of this.historyPreimages.getStore()!) {
                if (raw === null || !isHistoryDocument(path)) continue;
                const id = parseFrontmatter(raw).data.id;
                if (typeof id !== "string" || !nodes.has(id)) continue;
                const originalPath = path.slice(0, path.lastIndexOf("/"));
                beforeNodes.set(id, { ...nodes.get(id)!, path: originalPath });
                originals.set(id, { path, raw });
              }
              for (const change of changes) {
                if (
                  change.raw === null ||
                  !isHistoryDocument(change.path) ||
                  change.path.startsWith("roles/") ||
                  change.path.startsWith("cards/")
                )
                  continue;
                const id = parseFrontmatter(change.raw).data.id;
                if (typeof id !== "string" || !nodes.has(id)) continue;
                const original = originals.get(id),
                  previous = retained[id];
                const relocated =
                  previous && original
                    ? relocateNodeRecord(
                        previous,
                        original.raw,
                        original.path,
                        change.raw,
                        change.path,
                        beforeNodes,
                        nodes,
                      )
                    : previous;
                const prepared = await prepareNodeSyncSave(this, change.path, change.raw, {
                  nodes,
                  previous: relocated ?? undefined,
                  ...(original
                    ? { previousLocation: { documentPath: original.path, nodes: beforeNodes } }
                    : {}),
                });
                if (prepared.record) nodeRecords[id] = prepared.record;
              }
            }
            await this.history.captureUnlocked(changes, {
              operation: metadata?.operation ?? "document.capture",
              ...metadata,
              nodeRecords,
            });
          }
        } catch (error) {
          throw new Error(
            `Tent files may already be saved, but Git capture failed; reread before retrying: ${String(error)}`,
          );
        }
        return result;
      }),
    );
  }

  private async beforeHistoryChange(paths: string[]) {
    for (const path of paths) {
      const invalid = this.invalidNodeEdits?.get(path);
      if (invalid) throw new Error(`Invalid Node ${path}: ${invalid}`);
    }
    const tracked = this.historyWrites.getStore();
    if (!tracked) return;
    const before = [];
    const expected = new Map<string, string | null>();
    for (const path of new Set(paths.filter(isHistoryFile))) {
      const raw = await this.readFile(path).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (tracked.has(path) && tracked.get(path) !== raw)
        throw new Error(`Document changed before save: ${path}; reread before retrying`);
      expected.set(path, raw);
      if (tracked.has(path)) continue;
      this.historyPreimages.getStore()!.set(path, raw);
      tracked.set(path, raw);
      if (raw !== null) before.push({ path, raw });
    }
    // Preserve a selected preimage before destructive operations; never stage unrelated files.
    if (before.length)
      await this.history.captureUnlocked(before, { operation: "document.external-capture" });
    // Git can take time. An editor does not hold our lock: never overwrite edits
    // made during capture. The final filesystem operation is still not a CAS.
    for (const [path, raw] of expected) {
      const current = await this.readFile(path).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (current !== raw)
        throw new Error(`Document changed during Git capture: ${path}; reread before retrying`);
    }
    return tracked;
  }

  private async filesUnder(path: string): Promise<string[]> {
    const stat = await fs.lstat(this.abs(path)).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat || stat.isSymbolicLink()) return [];
    if (!stat.isDirectory()) return [path];
    const files: string[] = [];
    for (const entry of await fs.readdir(this.abs(path), { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      files.push(...(await this.filesUnder(`${path}/${entry.name}`)));
    }
    return files;
  }

  async withLock<T>(path: string, action: () => Promise<T>): Promise<T> {
    try {
      return await withFileMutationLock(
        this.abs(path),
        async () =>
          withoutStructureSnapshot(() =>
            withoutFileReadScope(() =>
              this.exists(".git").then((hasGit) =>
                hasGit ? this.history.withCaptureScope(action) : action(),
              ),
            ),
          ),
        {
          waitMs: 8_000,
          busyMessage:
            "Tent mutation lock is still busy after waiting 8 seconds; wait for the other write to finish, then reread before retrying.",
          acquireFailedMessage: "Cannot acquire the Tent mutation lock.",
        },
      );
    } finally {
      forgetScopedReads();
    }
  }
}

export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}
