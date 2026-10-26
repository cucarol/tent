import * as z from "zod/v4";
import type { FsAdapter } from "./adapter.js";
import type { NodeBasisRecord } from "../base/node-basis-record.js";

/** commit is an opaque immutable event identity, not a content fingerprint. */
export type DocumentVersion = { commit: string; path: string };
export const documentVersionSchema = z.strictObject({
  commit: z.string().regex(/^[a-f0-9]{64}$/),
  path: z.string().min(1),
});
export type DocumentChange = { path: string; raw: string | null };
export type CaptureMetadata = {
  operation: string;
  objectIds?: readonly string[];
  entry?: "cli" | "ui" | "core";
  nodeRecords?: Record<string, NodeBasisRecord>;
};
export type CaptureResult = {
  commit: string | null;
  created: boolean;
  versions: DocumentVersion[];
};
export type HistoryChange = {
  objectId?: string;
  before?: DocumentVersion;
  after?: DocumentVersion;
};
export type HistoryCommit = {
  commit: string;
  time: string;
  parent?: string;
  operation?: string;
  objectIds: string[];
  entry?: "cli" | "ui" | "core";
  changes: HistoryChange[];
};
export type VersionRead = {
  version: DocumentVersion;
  raw: string;
  changedSince: boolean;
  frontmatter?: Record<string, unknown>;
};
export type PublicationObserver = { before(commit: string): Promise<void>; after(): Promise<void> };

/** Immutable versions and publication; file recovery continues to belong to Core. */
export interface DocumentHistory {
  available(): Promise<boolean>;
  close(): Promise<void>;
  currentCommit(): Promise<string | null>;
  isPublished(commit: string): Promise<boolean>;
  withPublicationObserver<T>(observer: PublicationObserver, action: () => Promise<T>): Promise<T>;
  captureUnlocked(
    changes: readonly DocumentChange[],
    metadata?: CaptureMetadata,
  ): Promise<CaptureResult>;
  read(version: DocumentVersion): Promise<string>;
  readVersions(versions: readonly DocumentVersion[]): Promise<(VersionRead | Error)[]>;
  readDirectory(commit: string, directory?: string): Promise<Map<string, string>>;
  changedSince(version: DocumentVersion): Promise<boolean>;
  documentBlobs(): Promise<Map<string, string>>;
  retainedPaths(): Promise<string[]>;
  pathsUnder(prefix: string): Promise<string[]>;
  changedRetainedDocuments(
    documents: readonly { path: string; raw: string }[],
  ): Promise<{ path: string; raw: string; previousRaw: string }[]>;
  nodeRecords(): Promise<Record<string, NodeBasisRecord | null>>;
  unportableNodeRecordIds(): Promise<string[]>;
  pathVersions(file: string): Promise<{ first?: DocumentVersion; latest?: DocumentVersion }>;
  firstCommitTimes(files: readonly string[]): Promise<Map<string, string>>;
  cardQueueTimes(
    head: string,
    files: readonly string[],
  ): Promise<{ published: Map<string, string>; returned: Map<string, string> }>;
  completedCardPaths(completed: (file: string, raw: string) => boolean): Promise<Set<string>>;
  derived<T>(
    name: string,
    schemaVersion: number,
    compute: (head: string | null) => Promise<T>,
  ): Promise<T>;
  changesInRange(range?: { from?: string; to?: string }): Promise<HistoryCommit[]>;
  nodeVersions(nodeId: string): Promise<HistoryCommit[]>;
  commitChanges(commit: string): Promise<{
    parent: string;
    changes: { path: string; before: string | null; after: string | null }[];
  }>;
  diff(from: DocumentVersion, to: DocumentVersion): Promise<string>;
}

export async function hasDocumentHistory(fs: Pick<FsAdapter, "history">) {
  return !!fs.history && (await fs.history.available());
}
