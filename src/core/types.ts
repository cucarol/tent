import type { MaterialSource } from "./material.js";
import type { DocumentStatus } from "./document-status.js";
// The Tent 核心类型。这一层是唯一真相,插件和 CLI 都 import 它。

export type NodeType = string;

/** Node identity-file frontmatter. Canonical user Nodes persist non-empty `type` and `id`. */
export interface NodeFrontmatter {
  id: string;
  /** Canonical direct semantic marker; invalid disk rows may omit it in repair projections. */
  type?: NodeType;
  tags?: string[];
  resource?: string;
  sources?: MaterialSource[];
  /** Unknown lifecycle values remain raw metadata and receive a diagnostic. */
  status?: unknown;
  /** 允许 user 加自定义键,原样保留落盘。 */
  [k: string]: unknown;
}

/**
 * Parsed in-memory Node.
 */
export interface Node {
  id: string;
  /** Canonical direct semantic marker; invalid path-only projections may omit it. */
  type?: NodeType;
  tags: string[];
  status: DocumentStatus | null;
  statusDiagnostic?: string;
  /** Convenience projection of this document's status === deprecated. Never inherited. */
  archived: boolean;
  /** 自身或祖先引用了不存在的 type。失效子树退出正常流程。 */
  invalid: boolean;
  /** 直接失效的根节点 id;子孙沿用。 */
  invalidRootId?: string;
  invalidReason?: string;
  /** 相对帐根(system root)的路径,如 "goal/挖新alpha"。 */
  path: string;
  /** 显示名 = 文件夹名。 */
  name: string;
  fm: NodeFrontmatter;
  /** Exact content etag of the raw Node identity file read into this projection. */
  etag: string;
  /** Node identity-file body (the content after frontmatter). */
  body: string;
  children: Node[];
  parent: Node | null;
}
