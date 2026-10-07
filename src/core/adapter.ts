// Core 通过文件系统接口读写；CLI 使用 NodeFs，测试可以使用内存实现。

import { MUTATION_LOCK_PATH } from "./paths.js";
import { recoverPendingNodeMoveUnlocked } from "./node-move-recovery.js";
import { recoverPendingDeleteUnlocked } from "./delete-recovery.js";
import type { GitDocumentHistory, CaptureMetadata } from "./git-history.js";
import type { RepositoryMaterial } from "./repository-material.js";

export interface FsAdapter {
  /** Observe local material content; normalize text lines and select addressed Markdown sections. */
  observeMaterial?(
    resource: string,
    documentPath: string,
    repository?: RepositoryMaterial,
  ): Promise<{
    observedVersion: string;
    systemPath?: string;
    repository?: RepositoryMaterial;
    /** Present only when a missing declaration was read from another checkout. */
    readFrom?: string;
  }>;
  readonly history?: GitDocumentHistory;
  /** Track selected identity-document writes inside the existing mutation lock. */
  withDocumentHistory?<T>(action: () => Promise<T>, metadata?: CaptureMetadata): Promise<T>;
  /** 列出 dir 下的直接子项(相对帐根的路径)。 */
  listDir(dir: string): Promise<{ name: string; isDir: boolean }[]>;
  readFile(path: string): Promise<string>;
  /** Read the original Markdown frontmatter prefix, or an empty string without an opening fence. */
  readFrontmatter?(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /**
   * Read raw bytes (attachments, non-UTF-8 payloads).
   * Path traversal defenses must match readFile.
   */
  readBinary(path: string): Promise<Uint8Array>;
  /**
   * Write raw bytes. Prefer atomic temp+rename where the backend allows.
   * Path traversal defenses must match writeFile.
   */
  writeBinary(path: string, data: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  /** 移动/重命名(换爹或改名)。 */
  move(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Remove only an empty directory; fail without deleting any contained entries. */
  removeEmptyDir(path: string): Promise<void>;
  /** 跨进程短期写锁；实现可在锁过期后接管。 */
  withLock?<T>(path: string, action: () => Promise<T>): Promise<T>;
}

export interface Clock {
  /** ISO 字符串。抽象出来便于测试与 resume。 */
  now(): string;
}

/** Queries must report required repairs, never run a loader's repair writes. */
export function readOnlyFs(fs: FsAdapter): FsAdapter {
  return new Proxy(fs, {
    get(target, key, receiver) {
      if (
        [
          "writeFile",
          "writeBinary",
          "mkdir",
          "move",
          "remove",
          "removeEmptyDir",
          "withLock",
        ].includes(String(key))
      ) {
        return () => {
          throw new Error(
            "Reader source requires explicit repair; read operations never mutate it",
          );
        };
      }
      const value: unknown = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function withTentMutation<T>(
  fs: FsAdapter,
  action: (recovered: Awaited<ReturnType<typeof recoverPendingDeleteUnlocked>>) => Promise<T>,
  metadata?: CaptureMetadata,
): Promise<T> {
  // 唯一锁：始终 system root 下 mutation.lock，不使用嵌套 .tent/ 或其他路径。
  const actionWithHistory = async () => {
    const recovery = async () => {
      await recoverPendingNodeMoveUnlocked(fs);
      return recoverPendingDeleteUnlocked(fs);
    };
    const recovered = fs.withDocumentHistory
      ? await fs.withDocumentHistory(recovery, { operation: "workspace.recovery" })
      : await recovery();
    return fs.withDocumentHistory
      ? fs.withDocumentHistory(() => action(recovered), metadata)
      : action(recovered);
  };
  return fs.withLock ? fs.withLock(MUTATION_LOCK_PATH, actionWithHistory) : actionWithHistory();
}
