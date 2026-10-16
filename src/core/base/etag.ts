import { createHash } from "node:crypto";

/** Stable optimistic-concurrency token for exact persisted UTF-8 content. */
export function contentEtag(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 24);
}
