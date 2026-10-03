// node:fs 实现的 FsAdapter。给 CLI(skill 调用)和测试用。

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import type { FsAdapter, Clock } from "../core/adapter.js";
import { withFileMutationLock } from "./mutation-lock.js";
import { constants } from "node:fs";
import { checkedSourceFile } from "./checked-source-file.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { GitDocumentHistory, type CaptureMetadata } from "../core/git-history.js";
import { isHistoryDocument } from "../core/document-history.js";
import { renameWithRetry } from "./rename-with-retry.js";

export class NodeFs implements FsAdapter {
  private root: string;
  readonly history: GitDocumentHistory;
  private historyWrites = new AsyncLocalStorage<Map<string, string | null>>();

  constructor(root: string, entry: CaptureMetadata["entry"] = "core") {
    this.root = nodePath.resolve(root);
    this.history = new GitDocumentHistory(this.root, entry);
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
    const entries = await fs.readdir(this.abs(dir), { withFileTypes: true });
    return entries
      .filter((e) => !e.name.startsWith(".git"))
      .map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  }

  async readFile(path: string): Promise<string> {
    return fs.readFile(this.abs(path), "utf8");
  }

  async readFrontmatter(path: string): Promise<string> {
    const handle = await fs.open(this.abs(path), "r");
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    const chunk = Buffer.alloc(512);
    const opening = /^(\uFEFF)?---[\t ]*(\r?\n)/;
    const fence = /^---[\t ]*(?:\r?\n|$)/gm;
    let raw = "";
    let openingEnd = -1;
    let searchFrom = 0;
    try {
      while (true) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        const eof = bytesRead === 0;
        raw += decoder.decode(chunk.subarray(0, bytesRead), { stream: !eof });

        if (openingEnd < 0) {
          const match = opening.exec(raw);
          if (match) {
            openingEnd = match[0].length;
            searchFrom = openingEnd;
          } else if (eof || !/^(?:\uFEFF)?(?:-{0,2}|---[\t ]*\r?)$/.test(raw)) {
            return "";
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
            return raw.slice(0, end);
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
        if (eof) return raw;
      }
    } finally {
      await handle.close();
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    const abs = this.abs(path);
    const tracked = await this.beforeHistoryChange([path]);
    await fs.mkdir(nodePath.dirname(abs), { recursive: true });
    await this.atomicReplace(abs, content, "utf8");
    if (tracked && isHistoryDocument(path)) tracked.set(path, content);
  }

  async readBinary(path: string): Promise<Uint8Array> {
    const candidate = this.abs(path);
    await checkedSourceFile(this.root, candidate);
    const handle = await fs.open(
      candidate,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const before = await handle.stat(),
        current = await checkedSourceFile(this.root, candidate);
      if (before.dev !== current.dev || before.ino !== current.ino)
        throw new Error("Source changed while opening");
      const buf = await handle.readFile();
      const after = await handle.stat(),
        final = await checkedSourceFile(this.root, candidate);
      if (
        buf.length !== before.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        final.dev !== before.dev ||
        final.ino !== before.ino
      )
        throw new Error("Source changed while reading");
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } finally {
      await handle.close();
    }
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    const abs = this.abs(path);
    const tracked = await this.beforeHistoryChange([path]);
    await fs.mkdir(nodePath.dirname(abs), { recursive: true });
    const payload = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    await this.atomicReplace(abs, payload);
    if (tracked && isHistoryDocument(path))
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
    const files = this.historyWrites.getStore() ? await this.filesUnder(from) : [];
    const targets = files.map((file) => to + file.slice(from.length));
    const tracked = await this.beforeHistoryChange([...files, ...targets]);
    await fs.mkdir(nodePath.dirname(this.abs(to)), { recursive: true });
    await fs.rename(this.abs(from), this.abs(to));
    if (tracked)
      for (let i = 0; i < files.length; i++) {
        if (isHistoryDocument(files[i]!)) tracked.set(files[i]!, null);
        if (isHistoryDocument(targets[i]!))
          tracked.set(targets[i]!, await this.readFile(targets[i]!));
      }
  }

  async remove(path: string): Promise<void> {
    const files = this.historyWrites.getStore() ? await this.filesUnder(path) : [];
    const tracked = await this.beforeHistoryChange(files);
    await fs.rm(this.abs(path), { recursive: true, force: true });
    if (tracked) for (const file of files) if (isHistoryDocument(file)) tracked.set(file, null);
  }

  async removeEmptyDir(path: string): Promise<void> {
    await fs.rmdir(this.abs(path));
  }

  async withDocumentHistory<T>(action: () => Promise<T>, metadata?: CaptureMetadata): Promise<T> {
    if (!(await this.exists(".git"))) return action();
    return this.historyWrites.run(new Map(), async () => {
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
        if (changes.length) await this.history.captureUnlocked(changes, metadata);
      } catch (error) {
        throw new Error(
          `Tent files may already be saved, but Git capture failed; reread before retrying: ${String(error)}`,
        );
      }
      return result;
    });
  }

  private async beforeHistoryChange(paths: string[]) {
    const tracked = this.historyWrites.getStore();
    if (!tracked) return;
    const before = [];
    const expected = new Map<string, string | null>();
    for (const path of new Set(paths.filter(isHistoryDocument))) {
      const raw = await this.readFile(path).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (tracked.has(path) && tracked.get(path) !== raw)
        throw new Error(`Document changed before save: ${path}; reread before retrying`);
      expected.set(path, raw);
      if (tracked.has(path)) continue;
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
    return withFileMutationLock(this.abs(path), action, {
      busyMessage: "Tent is already running another write operation; try again later.",
      acquireFailedMessage: "Cannot acquire the Tent mutation lock.",
    });
  }
}

export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}
