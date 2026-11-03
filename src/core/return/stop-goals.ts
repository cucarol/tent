import path from "node:path";
import type { DocumentHistory, DocumentVersion } from "../store/history-port.js";
import { parseFrontmatter } from "../base/frontmatter.js";
import { canonicalSha256 } from "../base/canonical-digest.js";
import type { StopNodePointer } from "./stop-coverage.js";

type Span = { nodeId: string; before?: DocumentVersion; after?: DocumentVersion };

/** What a goal says: its type, description, status and body. Names and places are not the will. */
function meaning(raw: string | undefined) {
  if (raw === undefined) return { goal: false, digest: "" };
  try {
    const { data, body } = parseFrontmatter(raw);
    return {
      goal: data.type === "goal",
      digest: canonicalSha256([data.type, data.description, data.status, body]),
    };
  } catch {
    // A malformed version is reported as a document problem, not as a changed will.
    return { goal: false, digest: "" };
  }
}

/** Goals created, edited, archived or deleted between two history commits; moves and renames alone do not count. */
export async function changedGoals(
  history: DocumentHistory,
  systemRoot: string,
  from: string,
  to: string,
): Promise<StopNodePointer[]> {
  if (from === to) return [];
  const spans = new Map<string, Span>();
  for (const commit of await history.changesInRange({ from, to }))
    for (const change of commit.changes) {
      if (!change.objectId?.startsWith("node-")) continue;
      const span = spans.get(change.objectId);
      if (!span)
        spans.set(change.objectId, {
          nodeId: change.objectId,
          ...(change.before ? { before: change.before } : {}),
          ...(change.after ? { after: change.after } : {}),
        });
      else if (change.after) span.after = change.after;
      else delete span.after;
    }
  const versions = [...spans.values()].flatMap((span) => [span.before, span.after]);
  const reads = await history.readVersions(
    versions.filter((version): version is DocumentVersion => !!version),
  );
  const raws = new Map<DocumentVersion, string>();
  let next = 0;
  for (const version of versions) {
    if (!version) continue;
    const read = reads[next++];
    if (read && !(read instanceof Error)) raws.set(version, read.raw);
  }
  const goals: StopNodePointer[] = [];
  for (const span of spans.values()) {
    const before = meaning(span.before && raws.get(span.before));
    const after = meaning(span.after && raws.get(span.after));
    if (!before.goal && !after.goal) continue;
    if (before.goal === after.goal && before.digest === after.digest) continue;
    const file = (span.after ?? span.before)!.path;
    goals.push({
      nodeId: span.nodeId,
      name: path.posix.basename(path.posix.dirname(file)),
      path: path.resolve(systemRoot, file),
      type: "goal",
    });
  }
  return goals;
}
