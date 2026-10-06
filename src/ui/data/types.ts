// Read model the Web UI renders; `tent ui` serves it (src/ui-server/snapshot.ts builds it from Core).
import type { CardProgress } from "../../core/card-progress.js";

export type RefKind = "node" | "role" | "card";
export type SnapshotRef = { kind: RefKind; id: string };

export type SnapshotLink = { label: string; href: string; ref: SnapshotRef | null };

export type SnapshotMaterial = {
  kind: RefKind | "file" | "uri" | "text" | "invalid";
  resource: string;
  id?: string;
  uri?: string;
  workspacePath?: string;
  error?: string;
  field?: "resource" | "sources";
  index?: number;
  title?: string;
};

export type DocumentVersion = { commit: string; path: string };

export type SnapshotIncoming = {
  from: SnapshotRef;
  via: "link" | "resource" | "sources" | "card-source";
  version?: DocumentVersion;
  changedSince?: boolean;
};

/**
 * A Node that needs attention, computed from the real workspace on each request: a goal whose intent
 * has no current output (ahead), or a Node whose materials moved on (behind). The two are independent,
 * so a goal with no output whose materials changed carries both. Every other Node is absent.
 */
export type SyncFlag = {
  ahead?: { since?: string; reasons: string[] };
  behind?: { reasons: string[] };
};
export type SyncFlags = Record<string, SyncFlag>;

export type SnapshotNode = {
  id: string;
  name: string;
  path: string;
  notePath: string;
  depth: number;
  type: string;
  tags: string[];
  status: string;
  archived: boolean;
  description: string;
  body: string;
  parentId: string | null;
  childIds: string[];
  links: SnapshotLink[];
  materials: SnapshotMaterial[];
  incoming: SnapshotIncoming[];
  history: string[];
  /** Latest valid generation or verification time in the current output, normalized to UTC ISO. */
  outputAt?: string;
};

export type SnapshotRole = {
  id: string;
  title: string;
  status: string;
  path: string;
  body: string;
  links: SnapshotLink[];
  incoming: SnapshotIncoming[];
  history: string[];
};

export type CardSource = SnapshotMaterial & {
  version: DocumentVersion | null;
  changedSince: boolean;
};

export type SnapshotCard = {
  id: string;
  title: string;
  state: "pending" | "consumed";
  progress: CardProgress | null;
  goalCount: number;
  totalGoalCount: number;
  outputNodeIds: string[];
  reviewGoalCount?: number;
  reviewOutputNodeIds?: string[];
  target: string | null;
  receivedBy: string | null;
  status: string;
  body: string;
  sources: CardSource[];
  path: string;
  history: string[];
  publishedAt: string | null;
  updatedAt: string | null;
};

/** One changed identity document; its diff is fetched on demand from the before/after versions. */
export type SnapshotFile = {
  path: string;
  status: "A" | "M" | "D";
  ref: SnapshotRef | null;
  before?: DocumentVersion;
  after?: DocumentVersion;
};
export type SnapshotCommit = {
  hash: string;
  parent: string | null;
  date: string;
  operation?: string;
  entry?: string;
  objectIds: string[];
  files: SnapshotFile[];
};

export type Snapshot = {
  workspace: { id: string; name: string; revision: string; generatedAt: string };
  nodes: SnapshotNode[];
  roles: SnapshotRole[];
  cards: SnapshotCard[];
  commits: SnapshotCommit[];
  paths: Record<string, SnapshotRef>;
};
