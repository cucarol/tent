import type { DocumentRef } from "../graph/workspace-relations.js";
import type { CardDocumentState } from "../graph/card-document.js";
import type { DocumentVersion } from "../store/history-port.js";

export type NodeDetailFile = {
  path: string;
  status: "A" | "M" | "D";
  ref: DocumentRef | null;
  before?: DocumentVersion;
  after?: DocumentVersion;
};

export type NodeHistoryEntry = { hash: string; date: string; file: NodeDetailFile };
export type NodeHistoryDetails = { nodeId: string; items: NodeHistoryEntry[] };

export type NodeDetailMaterial = {
  kind: DocumentRef["kind"] | "file" | "uri" | "text" | "invalid";
  resource: string;
  id?: string;
  uri?: string;
  workspacePath?: string;
  error?: string;
  field?: "resource" | "sources";
  index?: number;
  title?: string;
};

export type NodeCardSource = NodeDetailMaterial & {
  version: DocumentVersion | null;
  changedSince: boolean;
};

export type NodeRoleSummary = { id: string; title: string; status: string };

export type NodeCardSummary = {
  id: string;
  title: string;
  state: CardDocumentState;
  status: string | null;
  target: string | null;
  receivedBy: string | null;
  returnTo?: string;
  publishedAt: string;
  sources: NodeCardSource[];
  lane: { id: string | null; title: string | null };
};

export type NodeCardsDetails = {
  nodeId: string;
  items: NodeCardSummary[];
  diagnostics: { cardId: string; index?: number; resource?: string; error: string }[];
};

export type NodeDetailRef = DocumentRef & { title: string; exists: boolean };
export type NodeDetailLink = { label: string; href: string; ref: DocumentRef | null };
export type NodeIncomingSummary = {
  from: DocumentRef;
  via: "link" | "mention" | "resource" | "sources" | "card-source";
  version?: DocumentVersion;
  changedSince?: boolean;
  title: string;
  cardState?: CardDocumentState;
};

/** Outgoing reads only selected text; incoming is a separate, whole-workspace inspection. */
export type NodeRelationsDetails = {
  nodeId: string;
  links: NodeDetailLink[];
  materials: NodeDetailMaterial[];
  incoming: NodeIncomingSummary[];
  roles: NodeRoleSummary[];
  refs: NodeDetailRef[];
};
