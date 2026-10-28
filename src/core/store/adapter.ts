// Core 通过文件系统接口读写；CLI 使用 NodeFs，测试可以使用内存实现。

import type { DocumentHistory } from "./history-port.js";
import { MUTATION_LOCK_PATH } from "../base/paths.js";
import { recoverPendingNodeMoveUnlocked } from "./node-move-recovery.js";
import { recoverPendingDeleteUnlocked } from "./delete-recovery.js";
import type { CaptureMetadata } from "./history-port.js";

/** Prefix and decoded-text blob fingerprint from one current document observation. */
export type DocumentHeaderObservation = { content: string; fingerprint: string };
export type ObservationOptions = {
  forceContent?: boolean;
  /** Valid Node document paths already checked by this read-only inspection. */
  nodePaths?: ReadonlySet<string>;
};

export interface FsAdapter {
  /** Available for adapters rooted at a Workspace's .tent directory. */
  readonly workspaceRoot?: string;
  /** Native edits rejected at this command boundary; never persisted or used as a cache. */
  invalidNodeEdits?: ReadonlyMap<string, string>;
  /** External edits preserved while settling an interrupted file transaction. */
  readonly recoveryConflicts?: readonly string[];
  /** Settle the current write's durable record under its already-held mutation lock. */
  recoverFileTransaction?(): Promise<readonly string[] | undefined>;
  prepareFileTransaction?(
    writes: readonly { path: string; before: string | null; after: string | null }[],
    directories: readonly string[],
  ): Promise<void>;
  /** Observe explicit content or safely validate a coverage address without reading members. */
  observeMaterial?(
    resource: string,
    documentPath: string,
    track?: "structure",
    structureResources?: readonly string[],
  ): Promise<{
    observedVersion?: string;
    coverage?: true;
    structureDependencies?: string[];
    systemPath?: string;
  }>;
  /** Share one Workspace observation among the materials of a single inspection. */
  observationScope?<T>(action: () => Promise<T>, options?: ObservationOptions): Promise<T>;
  /** Git index membership of an explicit local file; undefined when it cannot be established. */
  materialIsTracked?(resource: string, documentPath: string): Promise<boolean | undefined>;
  /** Validated local text for explicit-write advice; never fetch remote materials. */
  readMaterialText?(resource: string, documentPath: string): Promise<string | undefined>;
  readonly history?: DocumentHistory;
  /** File paths in the independent retained history tree; undefined without Tent history. */
  retainedDocumentPaths?(): Promise<string[] | undefined>;
  /** Track selected identity-document writes inside the existing mutation lock. */
  withDocumentHistory?<T>(action: () => Promise<T>, metadata?: CaptureMetadata): Promise<T>;
  /** 列出 dir 下的直接子项(相对帐根的路径)。 */
  listDir(dir: string): Promise<{ name: string; isDir: boolean }[]>;
  readFile(path: string): Promise<string>;
  /** Read the original Markdown frontmatter prefix, or an empty string without an opening fence. */
  readFrontmatter?(path: string): Promise<string>;
  /** Current Markdown prefix and full decoded-text SHA-256 blob fingerprint. */
  readFrontmatterWithFingerprint?(path: string): Promise<DocumentHeaderObservation>;
  writeFile(path: string, content: string): Promise<void>;
  /**
   * Read raw bytes, including non-UTF-8 payloads.
   * Path traversal defenses must match readFile.
   */
  readBinary(path: string): Promise<Uint8Array>;
  /** Content digest validated against current file state; implementations may reuse an unracy observation. */
  readContentDigest?(path: string): Promise<{ size: number; digest: string }>;
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
          "prepareFileTransaction",
          "recoverFileTransaction",
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
  /** Runs under the lock, outside history tracking, after the action or its capture fails. */
  onFailure?: (error: unknown) => Promise<void>,
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
    try {
      return fs.withDocumentHistory
        ? await fs.withDocumentHistory(() => action(recovered), metadata)
        : await action(recovered);
    } catch (error) {
      await onFailure?.(error);
      throw error;
    }
  };
  return fs.withLock ? fs.withLock(MUTATION_LOCK_PATH, actionWithHistory) : actionWithHistory();
}
