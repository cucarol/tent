import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { git } from "./helpers.js";
import {
  makeContextBrief,
  formatContextBrief,
  findUnlinkedOutputs,
  type CurrentContext,
} from "../src/core/context-brief.js";

async function fixture(t: TestContext) {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "context-phase1-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await scaffoldInWorkspace(new NodeFs(root), { name: "Context" });
  await git(path.join(root, ".tent"), "init");
  const options = { workspace: root, json: true };
  const node = async (sub: string, args: string[], stdin?: unknown) => {
    const result = await runNodeCommand(sub, args, {
      ...options,
      ...(stdin === undefined ? {} : { stdin: JSON.stringify(stdin) }),
    });
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const workspace = async (sub: string, args: string[] = []) => {
    const result = await runWorkspaceCommand(sub, args, options);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    return { value: JSON.parse(result.stdout), stdout: result.stdout };
  };
  return { root, options, node, workspace };
}

test("without Hooks the complete requirement, output, drift, review and unanchored-decision scenario works", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "requirement.md"), "Requirement version one");
  const created = await f.node("create", [
    "Requirement",
    "--type",
    "goal-requirement",
    "--resource",
    "../../requirement.md",
    "--body",
    "Confirmed requirement",
  ]);
  const id = created.node.nodeId;
  const ahead = await f.node("check", [id]);
  assert.equal(ahead.state, "ahead");
  assert.ok(ahead.aheadSince);
  await fs.writeFile(path.join(f.root, "result.html"), "<h1>Implemented</h1>");
  let read = await f.node("get", [id, "--full"]);
  const linked = await f.node("link-output", [
    id,
    "--resource",
    "../../result.html",
    "--provenance",
    "inferred",
    "--base-etag",
    read.node.etag,
  ]);
  assert.ok(linked.etag);
  assert.equal("raw" in linked, false);
  assert.equal((await f.node("check", [id])).state, "synced");
  await fs.writeFile(path.join(f.root, "requirement.md"), "Requirement version two");
  const headBefore = await git(path.join(f.root, ".tent"), "rev-parse", "HEAD");
  let brief = await f.workspace("brief");
  assert.equal(brief.value.counts.behind, 1);
  assert.equal(brief.value.behind[0].nodeId, id);
  assert.ok(Buffer.byteLength(brief.stdout) <= 4096);
  let drift = (await f.workspace("drift")).value;
  assert.ok(
    drift.items.some(
      (item: { kind: string; nodeId?: string }) =>
        item.kind === "requirement-changed" && item.nodeId === id,
    ),
  );
  assert.equal(
    await git(path.join(f.root, ".tent"), "rev-parse", "HEAD"),
    headBefore,
    "read-only commands must not capture a new version",
  );
  read = await f.node("get", [id, "--full"]);
  await f.node("confirm", [id, "--base-etag", read.node.etag]);
  assert.equal((await f.node("check", [id])).state, "synced");
  await fs.writeFile(path.join(f.root, "loose.svg"), "<svg/>");
  const loose = await f.node("create", [
    "Loose output",
    "--type",
    "output-asset",
    "--resource",
    "../../loose.svg",
  ]);
  brief = await f.workspace("brief");
  assert.ok(
    brief.value.unlinkedOutputs.some(
      (item: { nodeId?: string }) => item.nodeId === loose.node.nodeId,
    ),
  );
  drift = (await f.workspace("drift")).value;
  assert.ok(
    drift.items.some(
      (item: { kind: string; nodeId?: string }) =>
        item.kind === "unlinked-output" && item.nodeId === loose.node.nodeId,
    ),
  );
  const decision = await f.node("create", [
    "Conversation decision",
    "--type",
    "prompt-decision",
    "--body",
    "A decision made in conversation",
  ]);
  assert.equal((await f.node("check", [decision.node.nodeId])).state, "unanchored");
  brief = await f.workspace("brief");
  assert.equal(brief.value.counts.unanchored, 1);
  assert.equal(
    Object.values(brief.value)
      .flat()
      .some((item: any) => item?.nodeId === decision.node.nodeId),
    false,
  );
});

test("CLI planned writes and explicit implementation confirmation use full live read bases", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "basis.txt"), "evidence");
  const created = await f.node("create", [
    "Plan",
    "--type",
    "prompt-rule",
    "--planned",
    "--resource",
    "../../basis.txt",
  ]);
  const id = created.node.nodeId;
  assert.equal((await f.node("check", [id])).state, "ahead");
  let read = await f.node("get", [id, "--full"]);
  await f.node("confirm", [id, "--base-etag", read.node.etag]);
  assert.equal(
    (await f.node("check", [id])).state,
    "ahead",
    "ordinary confirmation does not claim implementation",
  );
  read = await f.node("get", [id, "--full"]);
  await f.node("confirm", [id, "--implemented", "--base-etag", read.node.etag]);
  assert.equal((await f.node("check", [id])).state, "synced");
  read = await f.node("get", [id, "--full"]);
  await f.node("write", [id, "--input-json", "-"], { baseEtag: read.node.etag, planned: true });
  assert.equal((await f.node("check", [id])).state, "ahead");
  const rejected = await runNodeCommand(
    "confirm",
    [id, "--base-etag", `read:${(await f.node("get", [id, "--full"])).node.etag}`],
    f.options,
  );
  assert.equal(rejected.exitCode, 1);
  assert.match(rejected.stderr, /complete|incomplete|full/i);
});

test("a Unicode-heavy brief stays within 4 KiB in both forms and retains counts and complete identities", () => {
  const nodes = Array.from({ length: 100 }, (_, i) => ({
    nodeId: `node-${i}`,
    path: `一个很长的名字${"非常长".repeat(200)}`,
    type: "goal",
    state: (i % 2 ? "ahead" : "behind") as "ahead" | "behind",
    aheadSince: "2026-01-01T00:00:00.000Z",
    materials: [],
    outputs: [],
    reasons: ["材料变化".repeat(100)],
  }));
  const context: CurrentContext = {
    sync: {
      nodes,
      counts: { synced: 0, ahead: 50, behind: 50, unanchored: 9 },
      unlinkedOutputs: [],
      requirementsWithoutOutputs: [],
    },
    observations: { events: [], uncertain: false },
    cards: { revision: "r", items: [] },
    unlinkedOutputs: [{ address: "输出".repeat(5000), modifiedAt: "2026-02-01T00:00:00.000Z" }],
  };
  const brief = makeContextBrief(context, { now: "2026-02-01T00:00:00.000Z" });
  assert.deepEqual(brief.counts, context.sync.counts);
  assert.ok(Buffer.byteLength(JSON.stringify(brief) + "\n") <= 4096);
  assert.ok(Buffer.byteLength(formatContextBrief(brief) + "\n") <= 4096);
  assert.match(
    formatContextBrief(brief).split("\n")[0],
    /^synced 0 · ahead 50 · behind 50 · unanchored 9$/,
  );
  assert.ok(brief.omitted.behind > 0 && brief.omitted.ahead > 0);
  assert.equal(
    brief.unlinkedOutputs.length,
    0,
    "an address never becomes a misleading truncated path",
  );
  assert.ok(brief.ahead[0].ageSeconds === 31 * 24 * 3600);
});

test("brief counts historical unlinked outputs but only lists recent Nodes and three recent sessions", () => {
  const times = ["2026-02-01", "2026-01-31", "2026-01-30", "2026-01-29", "2026-01-01"];
  const events = times.map((day, index) => ({
    schema: 1 as const,
    type: "turn" as const,
    sessionId: `session-${index}`,
    turnId: "turn-1",
    observedAt: `${day}T00:00:00.000Z`,
    files: [],
    signals: [],
    uncertain: false,
  }));
  const context: CurrentContext = {
    sync: {
      nodes: [],
      counts: { synced: 0, ahead: 0, behind: 0, unanchored: 0 },
      unlinkedOutputs: [],
      requirementsWithoutOutputs: [],
    },
    observations: { events, uncertain: false },
    cards: { revision: "r", items: [] },
    unlinkedOutputs: [
      { nodeId: "recent-node", modifiedAt: "2026-01-31T00:00:00.000Z" },
      { nodeId: "old-node", modifiedAt: "2026-01-01T00:00:00.000Z" },
      { nodeId: "unknown-node" },
      ...events.map((event, index) => ({
        address: `file-${index}.md`,
        observedAt: event.observedAt,
        sessionId: event.sessionId,
      })),
    ],
  };
  const brief = makeContextBrief(context, { now: "2026-02-01T00:00:00.000Z" });
  assert.deepEqual(
    new Set(brief.unlinkedOutputs.map((item) => item.nodeId ?? item.address)),
    new Set(["recent-node", "file-0.md", "file-1.md", "file-2.md"]),
  );
  assert.equal(brief.omitted.unlinkedOutputs, 4);
  assert.match(formatContextBrief(brief), /4 older or omitted unlinked outputs/);
  assert.equal(context.unlinkedOutputs.length, 8, "the full drift source remains intact");
});

test("uncertain Node associations never become a definite unlinked file claim", () => {
  const context: CurrentContext = {
    sync: {
      nodes: [
        {
          nodeId: "node-racing",
          path: "Racing",
          type: "goal",
          state: "unanchored",
          uncertain: true,
          materials: [],
          outputs: [],
          reasons: ["Node changed during inspection"],
        },
      ],
      counts: { synced: 0, ahead: 0, behind: 0, unanchored: 1 },
      unlinkedOutputs: [],
      requirementsWithoutOutputs: [],
    },
    observations: {
      events: [
        {
          schema: 1,
          type: "turn",
          sessionId: "one",
          turnId: "one",
          observedAt: "2026-02-01T00:00:00.000Z",
          files: [
            {
              kind: "written",
              address: "already-linked.txt",
              version: {
                state: "observed",
                sha256: "a".repeat(64),
                phase: "stop",
                observedAt: "2026-02-01T00:00:00.000Z",
              },
            },
          ],
          signals: [],
          uncertain: false,
        },
      ],
      uncertain: false,
    },
    cards: { revision: "r", items: [] },
    unlinkedOutputs: [],
  };
  assert.deepEqual(
    findUnlinkedOutputs(context.sync, context.observations.events, process.cwd()),
    [],
  );
  const brief = makeContextBrief(context);
  assert.equal(brief.synchronizationUncertain, true);
  assert.match(formatContextBrief(brief), /findings are incomplete/);
  assert.ok(Buffer.byteLength(formatContextBrief(brief) + "\n") <= 4096);
});
