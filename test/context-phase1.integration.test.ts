import { openTestFs, removeTestFixture } from "./node-fs.js";
import { historyHead } from "./scratch.js";
import { initializeFixtureHistory } from "./scratch.js";
import { testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { scaffoldInWorkspace } from "./scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { runCardCommand } from "../src/cli/card-commands.js";
import { runRoleCommand } from "../src/cli/role-commands.js";
import { git } from "./helpers.js";
import { parseFrontmatter } from "../src/core/base/frontmatter.js";
import {
  inspectCurrentContext,
  makeContextBrief,
  formatContextBrief,
  contextDriftItems,
  type CurrentContext,
} from "../src/core/read/context-brief.js";
import type { FsAdapter } from "../src/core/store/adapter.js";
import { loadNodeCatalog } from "../src/core/graph/node-catalog.js";

test("brief reports native capture failure without unhandled unused Card query promises", async () => {
  const adapter = {
    exists: async () => false,
    listDir: async () => [],
  } as unknown as FsAdapter;
  const failure = new Error("capture failed");
  await assert.rejects(
    inspectCurrentContext(adapter, { nodes: Promise.reject(failure) }),
    (error) => error === failure,
  );
  // Node's test runner reports any unhandled rejection from unused query branches.
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("brief limits each waiting list independently and retains totals, read commands and full paths", () => {
  const pending = Array.from({ length: 40 }, (_, i) => ({
    cardId: `card-pending${i}`,
    state: "pending",
    orderKey: String(i).padStart(3, "0"),
    title: "待接收的工作".repeat(8),
    ...(i === 0 ? { diagnostic: "Source unavailable" } : {}),
  }));
  const returned = Array.from({ length: 12 }, (_, i) => ({
    cardId: `card-returned${i}`,
    state: "returned",
    title: `Completed ${i}`,
    returnTo: "role-requester",
    receivedBy: "role-worker",
    result: "Full receipt belongs in card show",
    publishedAt: `2026-10-${String(30 - i).padStart(2, "0")}T00:00:00Z`,
  }));
  const invalidNodes = Array.from({ length: 11 }, (_, i) => ({
    path: `.tent/${"很长的实际目录".repeat(30)}/${i}.md`,
    reason: "Invalid frontmatter",
  }));
  const context: CurrentContext = {
    workspaceRoot: "D:/Workspace with spaces/Tent",
    roots: Array.from({ length: 13 }, (_, i) => ({
      nodeId: `node-root${i}`,
      name: `Root ${i}`,
      type: "prompt",
      path: `.tent/Root ${i}/Root ${i}.md`,
    })),
    sync: {
      invalidNodes,
      nodes: [
        {
          nodeId: "node-legacy",
          path: "Legacy",
          state: "behind",
          trustTier: "unverified",
          stale: false,
          behind: { reasons: ["Node record missing; no retained baseline"] },
          materials: [
            {
              resource: "/Legacy/Legacy.md",
              state: "unavailable",
              reason: "Node record missing; no retained baseline",
            },
          ],
          reasons: [],
        },
      ],
      counts: { synced: 0, ahead: 0, behind: 1, unanchored: 0 },
      outputNodes: [],
      requirementsWithoutOutputs: [],
    },
    cards: {
      revision: "fixture",
      items: [
        ...pending,
        ...returned,
        { cardId: "card-unknown", diagnostic: "Card header unavailable; inspect raw" },
      ],
    },
    changedCardSources: { items: [], diagnostics: [{ message: "Could not compare" }] },
    recoveryConflicts: ["a/complete recovery path.md"],
  };
  const brief = makeContextBrief(context);
  const withoutRoots = makeContextBrief({ ...context, roots: [] });
  assert.deepEqual(brief.cardInputs, withoutRoots.cardInputs);
  assert.deepEqual(brief.ahead, withoutRoots.ahead);
  assert.deepEqual(brief.behind, withoutRoots.behind);
  assert.equal(brief.roots.length, 10);
  assert.equal(brief.omitted.roots, 3);
  assert.deepEqual(Object.keys(brief).slice(0, 5), [
    "counts",
    "invalidNodes",
    "cardInputs",
    "ahead",
    "changedCardSources",
  ]);
  assert.deepEqual(
    brief.cardInputs.filter((item) => item.state === "pending").map((item) => item.cardId),
    pending.slice(0, 10).map((item) => item.cardId),
  );
  assert.deepEqual(
    brief.cardInputs.filter((item) => item.state === "returned").map((item) => item.cardId),
    returned.slice(0, 10).map((item) => item.cardId),
  );
  assert.equal(brief.omitted.cardInputs, 32);
  assert.deepEqual(brief.invalidNodes, invalidNodes.slice(0, 10));
  assert.equal(brief.omitted.invalidNodes, 1);
  assert.deepEqual(brief.pendingCardsRead, {
    total: 40,
    command: "tent card list --state pending --workspace 'D:/Workspace with spaces/Tent'",
  });
  assert.deepEqual(brief.returnedCardsRead, {
    total: 12,
    command: "tent card list --state returned --workspace 'D:/Workspace with spaces/Tent'",
  });
  assert.deepEqual(brief.invalidNodesRead, {
    total: 11,
    command: "tent workspace check --json --workspace 'D:/Workspace with spaces/Tent'",
  });
  assert.equal(brief.cardInputs.find((item) => item.cardId === "card-unknown")?.state, "unknown");
  assert.ok(brief.cardInputs.every((item) => !("path" in item) && !("result" in item)));
  assert.deepEqual(brief.roots[0], { nodeId: "node-root0", name: "Root 0", type: "prompt" });
  assert.equal(brief.cardSourcesUncertain, true);
  assert.equal(brief.baselineOnlyBehind, 1);
  assert.deepEqual(brief.behind, []);
  const text = formatContextBrief(brief);
  assert.ok(text.indexOf("Root Nodes (13 total):") > text.indexOf("Input Cards"));
  assert.equal(brief.rootsRead!.total, 13);
  assert.ok(text.endsWith(`+3 more: ${brief.rootsRead!.command}`));
  assert.equal(
    brief.rootsRead!.command,
    "tent node list --workspace 'D:/Workspace with spaces/Tent'",
  );
  assert.ok(
    Buffer.byteLength(text) > 4096,
    "complete paths can exceed 4 KiB; there is no total byte cap",
  );
  assert.ok(text.includes("Invalid Nodes (11 total):"));
  for (const item of invalidNodes.slice(0, 10)) assert.ok(text.includes(item.path));
  for (const read of [brief.pendingCardsRead!, brief.returnedCardsRead!, brief.invalidNodesRead!])
    assert.ok(text.split("\n").includes(`+${read.total - 10} more: ${read.command}`));
  assert.match(text, /card-unknown.*Card header unavailable; inspect raw.*\[unknown\]/);
  assert.match(
    text,
    /Transaction recovery kept external edits:\n- .tent\/a\/complete recovery path.md/,
  );
  assert.doesNotMatch(text, /\.tent\/cards\/|Full receipt belongs/);
  assert.match(text, /1 behind Nodes have no retained baseline\./);
  assert.ok(text.includes("tent workspace drift --workspace 'D:/Workspace with spaces/Tent'"));
  const scoped = makeContextBrief(context, { roleId: "role-requester" });
  assert.equal(
    scoped.pendingCardsRead!.command,
    "tent card list --role role-requester --include-open --state pending --workspace 'D:/Workspace with spaces/Tent'",
  );
  assert.equal(
    scoped.returnedCardsRead!.command,
    "tent card list --role role-requester --state returned --workspace 'D:/Workspace with spaces/Tent'",
  );
  assert.deepEqual(scoped.counts, brief.counts);
});

async function fixture(t: TestContext) {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "context-phase1-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await scaffoldInWorkspace(openTestFs(root), { name: "Context" });
  await initializeFixtureHistory(path.join(root, ".tent"));
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

test("drift keeps oversized material findings readable and points to the complete current inspection", async (t) => {
  const f = await fixture(t);
  const files = Array.from({ length: 40 }, (_, i) => `material-${i}.md`);
  for (const file of files) await fs.writeFile(path.join(f.root, file), "old material\n");
  const many = await f.node(
    "create",
    ["Many", "--type", "prompt", "--sources-json", "-"],
    files.map((resource) => ({ resource })),
  );
  const later = await f.node("create", ["Later", "--type", "prompt", "--resource", files[0]!]);
  for (const file of files) await fs.writeFile(path.join(f.root, file), "new material\n");
  const id = many.node.nodeId;
  const checked = await f.node("check", [id]);
  assert.equal(checked.materials.length, 40);
  assert.ok(checked.materials.every((item: { state: string }) => item.state === "changed"));
  assert.ok(Buffer.byteLength(JSON.stringify(checked.materials)) > 8 * 1024);
  const first = await f.workspace("drift", ["--limit", "1"]);
  assert.ok(Buffer.byteLength(first.stdout.trim()) <= 16 * 1024);
  // Tree order is stable; find and follow both pages without assuming the created Node's id order.
  const second = await f.workspace("drift", ["--cursor", first.value.page.nextCursor]);
  const rows = [...first.value.items, ...second.value.items];
  assert.deepEqual(
    new Set(rows.map((item: { nodeId: string }) => item.nodeId)),
    new Set([id, later.node.nodeId]),
  );
  const row = rows.find((item: { nodeId: string }) => item.nodeId === id);
  assert.equal(row.kind, "node-behind");
  assert.equal(row.path, many.node.path);
  assert.deepEqual(row.reasons, checked.behind.reasons);
  assert.equal(row.materialsOmitted, true);
  assert.equal(row.materialCount, 40);
  assert.equal("materials" in row, false);
  assert.equal("metadataRead" in row, false);
  assert.deepEqual(row.inspectionRead, { nodeId: id, command: `tent node check ${id} --json` });
  const complete = await f.node("check", [row.inspectionRead.nodeId]);
  assert.deepEqual(complete.materials, checked.materials);
  const text = await runWorkspaceCommand("drift", [], { workspace: f.root });
  assert.equal(text.exitCode, 0, text.stderr);
  assert.ok(text.stdout.includes(`behind  ${id}`));
  assert.ok(text.stdout.includes(row.inspectionRead.command));
  assert.equal((await f.workspace("brief")).value.counts.behind, 2);
  // Even omitted evidence participates in the list revision; a continuation cannot hide a change.
  await fs.writeFile(path.join(f.root, files[1]!), "third version\n");
  const changed = await runWorkspaceCommand(
    "drift",
    ["--cursor", first.value.page.nextCursor],
    f.options,
  );
  assert.equal(changed.exitCode, 1);
  assert.match(changed.stderr, /SOURCE_CHANGED|source changed/i);
});

test("brief ignores retained session logs and has no unrecorded-file section", async (t) => {
  const f = await fixture(t);
  const adapter = openTestFs(path.join(f.root, ".tent"));
  const legacy = `temp/observations/${"a".repeat(64)}.jsonl`;
  await adapter.writeFile(legacy, "invalid old session log\n");
  const read = NodeFs.prototype.readFile;
  const list = NodeFs.prototype.listDir;
  t.mock.method(NodeFs.prototype, "readFile", async function (this: NodeFs, filename: string) {
    assert.ok(!filename.startsWith("temp/observations"));
    return read.call(this, filename);
  });
  t.mock.method(NodeFs.prototype, "listDir", async function (this: NodeFs, directory: string) {
    assert.ok(!directory.startsWith("temp/observations"));
    return list.call(this, directory);
  });
  const brief = (await f.workspace("brief")).value;
  assert.equal("unlinkedOutputs" in brief, false);
  assert.equal("observationUncertain" in brief, false);
  assert.equal("unlinkedOutputs" in brief.omitted, false);
  assert.doesNotMatch(formatContextBrief(brief), /unrecorded|Session observations/);
  assert.equal(await read.call(adapter, legacy), "invalid old session log\n");
});

test("brief exposes root identities without drift or another catalog scan", async (t) => {
  const f = await fixture(t);
  const created = await f.node("write-many", ["--input-json", "-"], {
    items: [
      { op: "create", ref: "map", name: "Map", type: "prompt", body: "Module map" },
      {
        op: "create",
        ref: "core",
        parent: "@map",
        name: "Core",
        type: "prompt",
        body: "Core module",
      },
      { op: "create", ref: "other", name: "Other", type: "prompt", body: "Other entry" },
      { op: "create", ref: "archived", name: "Archived", type: "prompt", body: "Old entry" },
    ],
  });
  await f.node("archive", [created.results[3].nodeId]);
  const adapter = openTestFs(path.join(f.root, ".tent"));
  const catalog = await loadNodeCatalog(adapter);
  const observed = new Proxy(adapter, {
    get(target, key) {
      if (key === "readFrontmatter")
        return () => {
          throw new Error("Root navigation must reuse the current catalog");
        };
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const context = await inspectCurrentContext(observed, {
    nodes: Promise.resolve({ catalog, invalidNodes: [] }),
  });
  const brief = makeContextBrief(context);
  assert.deepEqual(brief.counts, { ahead: 0, behind: 0 });
  assert.deepEqual(
    brief.roots,
    [0, 2].map((index) => ({
      nodeId: created.results[index].nodeId,
      name: index === 0 ? "Map" : "Other",
      type: "prompt",
    })),
  );
  const cli = await f.workspace("brief");
  assert.deepEqual(cli.value.roots, brief.roots);
  const text = await runWorkspaceCommand("brief", [], { workspace: f.root });
  assert.equal(text.exitCode, 0, text.stderr);
  assert.ok(text.stdout.includes(`${created.results[0].nodeId} Map [prompt]`));
  assert.doesNotMatch(text.stdout, /Archived|Core\/Core.md/);
});

test("without Hooks the complete requirement, output, drift, review and unanchored-decision scenario works", async (t) => {
  const f = await fixture(t);
  await git(f.root, "init", "--quiet");
  await fs.writeFile(path.join(f.root, "requirement.md"), "Requirement version one");
  const created = await f.node("create", [
    "Requirement",
    "--type",
    "goal",
    "--resource",
    "requirement.md",
    "--body",
    "Confirmed requirement",
  ]);
  const id = created.node.nodeId;
  const ahead = await f.node("check", [id]);
  assert.equal(ahead.state, "ahead");
  assert.deepEqual(ahead.ahead.reasons, ["Goal subtree has no current output Node"]);
  assert.equal("aheadSince" in ahead, false);
  await fs.writeFile(path.join(f.root, "result.html"), "<h1>Implemented</h1>");
  const linked = await f.node("link-output", [
    id,
    "--resource",
    "result.html",
    "--name",
    "Implementation",
  ]);
  assert.ok(linked.etag);
  assert.equal("raw" in linked, false);
  assert.notEqual(linked.nodeId, id);
  assert.equal(linked.path, ".tent/Requirement/Implementation/Implementation.md");
  assert.equal((await f.node("check", [id])).state, "synced");
  await fs.writeFile(path.join(f.root, "requirement.md"), "Requirement version two");
  const headBefore = await historyHead(path.join(f.root, ".tent"));
  let brief = await f.workspace("brief");
  assert.equal(brief.value.counts.behind, 1);
  assert.deepEqual(brief.value.behind, []);
  assert.equal(brief.value.driftRead.command, `tent workspace drift --workspace ${f.root}`);
  assert.ok(Buffer.byteLength(brief.stdout) <= 4096);
  let drift = (await f.workspace("drift")).value;
  const behind = drift.items.find(
    (item: { kind: string; nodeId: string }) => item.kind === "node-behind" && item.nodeId === id,
  );
  const checked = await f.node("check", [id]);
  assert.deepEqual(behind.materials, checked.materials);
  assert.equal(behind.materials[0].state, "changed");
  assert.notEqual(behind.materials[0].recordedVersion, behind.materials[0].currentVersion);
  assert.equal(
    drift.items.some((item: { kind: string }) => item.kind === "unlinked-output"),
    false,
  );
  assert.equal(
    await historyHead(path.join(f.root, ".tent")),
    headBefore,
    "read-only commands must not capture a new version",
  );
  let read = await f.node("get", [id, "--full"]);
  await f.node("confirm", [id, "--base-etag", read.etag]);
  assert.equal((await f.node("check", [id])).state, "ahead");
  assert.equal((await f.node("check", [linked.nodeId])).state, "synced");
  const outputRead = await f.node("get", [linked.nodeId, "--full"]);
  assert.deepEqual(outputRead.changedSince, [{ kind: "goal", nodeId: id, name: "Requirement" }]);
  await f.node("confirm", [linked.nodeId, "--base-etag", outputRead.etag]);
  assert.equal((await f.node("check", [id])).state, "synced");
  read = await f.node("get", [id, "--full"]);
  await f.node("write", [id, "--body", "Changed confirmed requirement", "--base-etag", read.etag]);
  assert.equal((await f.node("check", [id])).state, "ahead");
  assert.equal((await f.node("check", [linked.nodeId])).state, "synced");
  drift = (await f.workspace("drift")).value;
  assert.ok(
    drift.items.some(
      (item: { kind: string; nodeId?: string }) => item.kind === "node-ahead" && item.nodeId === id,
    ),
  );
  read = await f.node("get", [linked.nodeId, "--full"]);
  await f.node("write", [
    linked.nodeId,
    "--body",
    "Updated implementation",
    "--confirm",
    "--base-etag",
    read.etag,
  ]);
  assert.equal((await f.node("check", [id])).state, "synced");
  assert.equal((await f.node("check", [linked.nodeId])).state, "synced");
  const decision = await f.node("create", [
    "Conversation decision",
    "--type",
    "prompt",
    "--body",
    "A decision made in conversation",
  ]);
  assert.equal((await f.node("check", [decision.node.nodeId])).state, "unanchored");
  brief = await f.workspace("brief");
  assert.equal("unanchored" in brief.value.counts, false);
  assert.equal("synced" in brief.value.counts, false);
  assert.equal(
    Object.entries(brief.value)
      .filter(([key]) => key !== "roots")
      .map(([, value]) => value)
      .flat()
      .some((item: any) => item?.nodeId === decision.node.nodeId),
    false,
  );
  assert.ok(
    brief.value.roots.some((item: { nodeId: string }) => item.nodeId === decision.node.nodeId),
  );
});

test("CLI rejects retired flags and confirmation still requires a full live read basis", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "basis.txt"), "evidence");
  const created = await f.node("create", ["Plan", "--type", "prompt", "--resource", "basis.txt"]);
  const id = created.node.nodeId;
  assert.equal((await f.node("check", [id])).state, "synced");
  for (const [sub, flag] of [
    ["create", "--planned"],
    ["confirm", "--implemented"],
    ["link-output", "--provenance"],
  ]) {
    const result = await runNodeCommand(sub, [id, flag], f.options);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /unknown option/i);
  }
  const read = await f.node("get", [id, "--full"]);
  const legacyJson = await runNodeCommand("write", [id, "--input-json", "-"], {
    ...f.options,
    stdin: JSON.stringify({ baseEtag: read.etag, planned: true }),
  });
  assert.equal(legacyJson.exitCode, 1);
  const rejected = await runNodeCommand(
    "confirm",
    [id, "--base-etag", `read:${(await f.node("get", [id, "--full"])).etag}`],
    f.options,
  );
  assert.equal(rejected.exitCode, 1);
  assert.match(rejected.stderr, /complete|incomplete|full/i);
});

test("brief keeps Card delivery independent of goal outputs and only warns for changed source goals still ahead", async (t) => {
  const f = await fixture(t);
  const source = await f.node("create", [
    "Spec",
    "--type",
    "goal",
    "--body",
    "Original requirement",
  ]);
  const second = await f.node("create", [
    "Second",
    "--type",
    "goal",
    "--body",
    "Second requirement",
  ]);
  const card = async (sub: string, args: string[]) => {
    const result = await runCardCommand(sub, args, f.options);
    assert.equal(result.exitCode, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  for (const roleId of ["role-worker", "role-requester"]) {
    const created = await runRoleCommand("create", ["--id", roleId, "--title", roleId], f.options);
    assert.equal(created.exitCode, 0, created.stderr);
  }
  const published = await card("create", [
    "--target",
    "role-worker",
    "--return-to",
    "role-requester",
    "--prompt",
    "Implement the source.",
    "--source",
    source.node.nodeId,
    "--source",
    second.node.nodeId,
  ]);
  await card("take", [published.cardId, "--role", "role-worker"]);
  const received = (await f.workspace("brief")).value;
  assert.deepEqual(received.changedCardSources, []);
  assert.equal(received.cardInputs[0].state, "consumed");
  assert.equal(received.cardInputs[0].receivedBy, "role-worker");
  assert.equal(received.cardInputs[0].returnTo, "role-requester");
  await fs.writeFile(path.join(f.root, "result.html"), "<h1>result</h1>");
  const output = await f.node("link-output", [
    source.node.nodeId,
    "--resource",
    "result.html",
    "--card",
    published.cardId,
  ]);
  const outputRaw = await fs.readFile(path.join(f.root, output.path), "utf8");
  assert.equal(
    JSON.stringify(parseFrontmatter(outputRaw).data.sources ?? []).includes(published.cardId),
    true,
  );
  const withOutput = (await f.workspace("brief")).value;
  assert.deepEqual(withOutput.cardInputs, received.cardInputs);
  for (const key of [
    "progress",
    "outputCount",
    "goalCount",
    "totalGoalCount",
    "outputNodeIds",
    "reviewOutputNodeIds",
  ])
    assert.equal(key in withOutput.cardInputs[0], false);
  assert.equal(
    withOutput.counts.ahead,
    1,
    "goal progress remains visible independently of Card delivery",
  );
  const textBrief = await runWorkspaceCommand("brief", [], { workspace: f.root });
  assert.equal(textBrief.exitCode, 0, textBrief.stderr);
  assert.match(textBrief.stdout, /\[consumed\] received by role-worker return to role-requester/);
  assert.doesNotMatch(textBrief.stdout, /received-no-output|has-output|needs-review|1\/2/);
  const file = path.join(f.root, ".tent", "Spec", "Spec.md");
  const original = await fs.readFile(file, "utf8");
  await fs.writeFile(file, original.replace("Original requirement", "Changed requirement"));
  const head = await historyHead(path.join(f.root, ".tent"));
  const brief = await f.workspace("brief");
  assert.equal(brief.value.changedCardSources[0].cardId, published.cardId);
  assert.equal(brief.value.changedCardSources[0].nodeId, source.node.nodeId);
  assert.equal(brief.value.changedCardSources[0].state, "changed");
  assert.notEqual(
    await historyHead(path.join(f.root, ".tent")),
    head,
    "brief records the preceding native source edit",
  );
  const currentOutput = await f.node("get", [output.nodeId, "--full"]);
  await f.node("confirm", [output.nodeId, "--base-etag", currentOutput.etag]);
  assert.deepEqual(
    (await f.workspace("brief")).value.changedCardSources,
    [],
    "completed source goal removes old changed Card warning",
  );
  await f.node("link-output", [
    second.node.nodeId,
    "--resource",
    "result.html",
    "--card",
    published.cardId,
  ]);
  const allOutputs = (await f.workspace("brief")).value;
  assert.deepEqual(
    allOutputs.cardInputs,
    received.cardInputs,
    "goal outputs do not complete the Card",
  );
  assert.equal(allOutputs.counts.ahead, 0);
  await card("return", [
    published.cardId,
    "--role",
    "role-worker",
    "--result",
    `Done ${output.nodeId}`,
  ]);
  const returned = (await f.workspace("brief", ["--role", "role-requester"])).value;
  assert.equal(returned.cardInputs[0].state, "returned");
  assert.equal("result" in returned.cardInputs[0], false);
  assert.equal((await card("show", [published.cardId])).result, `Done ${output.nodeId}`);
  assert.deepEqual((await f.workspace("brief", ["--role", "role-worker"])).value.cardInputs, []);
  assert.deepEqual(
    (await f.workspace("brief", ["--role", "role-requester"])).value.cardInputs,
    returned.cardInputs,
  );
  await card("take", [published.cardId, "--role", "role-requester"]);
  assert.deepEqual(
    (await f.workspace("brief")).value.cardInputs,
    [],
    "taking the receipt closes its delivery",
  );
  const notice = await card("create", ["--prompt", "Read this", "--source", second.node.nodeId]);
  await card("take", [notice.cardId]);
  assert.deepEqual(
    (await f.workspace("brief")).value.cardInputs,
    [],
    "a Card without returnTo completes on take",
  );
  const shown = await card("show", [published.cardId]);
  await card("deprecate", [published.cardId, "--base-etag", shown.etag]);
  const after = (await f.workspace("brief")).value;
  assert.deepEqual(after.changedCardSources, []);
  assert.deepEqual(after.cardInputs, []);
});

test("brief reports only drift counts and a qualified entry while bounding other discovery without a byte cap", () => {
  const nodes = Array.from({ length: 100 }, (_, i) => ({
    nodeId: `node-${i}`,
    path: i === 1 ? "Short" : `一个很长的名字${"非常长".repeat(200)}`,
    type: "goal",
    state: (i % 2 ? "ahead" : "behind") as "ahead" | "behind",
    trustTier: "unverified" as const,
    stale: false,
    ...(i % 2
      ? { ahead: { reasons: ["No output"] } }
      : { behind: { reasons: ["材料变化".repeat(100)] } }),
    materials: [],
    reasons: ["材料变化".repeat(100)],
  }));
  const context: CurrentContext = {
    workspaceRoot: "D:/Frozen Tent",
    roots: [],
    sync: {
      invalidNodes: [],
      nodes,
      counts: { synced: 0, ahead: 50, behind: 50, unanchored: 9 },
      outputNodes: [],
      requirementsWithoutOutputs: [],
    },
    cards: { revision: "r", items: [] },
    changedCardSources: {
      items: Array.from({ length: 50 }, (_, i) => ({
        cardId: `card-${i}`,
        nodeId: `node-${i}`,
        resource: `/Source${i}/Source${i}.md`,
        state: "changed" as const,
        publishedVersion: { commit: "a".repeat(64), path: `Source${i}/Source${i}.md` },
        path: `${"完整的来源目录".repeat(100)}/${i}.md`,
        reason: "来源材料变化".repeat(100),
      })),
      diagnostics: [],
    },
  };
  const brief = makeContextBrief(context);
  assert.deepEqual(brief.counts, { ahead: 50, behind: 50 });
  assert.ok(Buffer.byteLength(JSON.stringify(brief) + "\n") > 4096);
  assert.ok(Buffer.byteLength(formatContextBrief(brief) + "\n") > 4096);
  assert.match(formatContextBrief(brief).split("\n")[0], /^behind 50 · ahead 50$/);
  assert.deepEqual(brief.ahead, []);
  assert.deepEqual(brief.behind, []);
  assert.deepEqual(
    brief.changedCardSources.map((item) => item.nodeId),
    [1, 3, 5, 7, 9, 11, 13, 15, 17, 19].map((i) => `node-${i}`),
  );
  assert.equal(brief.omitted.ahead, 50);
  assert.equal(brief.omitted.behind, 50);
  assert.equal(brief.omitted.changedCardSources, 15);
  assert.deepEqual(brief.driftRead, {
    command: "tent workspace drift --workspace 'D:/Frozen Tent'",
  });
  assert.deepEqual(brief.changedCardSourcesRead, {
    total: 25,
    command: "tent card list --state consumed --workspace 'D:/Frozen Tent'",
  });
  assert.equal(
    brief.changedCardSources[0].path,
    `.tent/${context.changedCardSources.items[1].path}`,
  );
  const read = brief.changedCardSourcesRead!;
  assert.ok(
    formatContextBrief(brief)
      .split("\n")
      .includes(`+${read.total - 10} more: ${read.command}`),
  );
  assert.equal(formatContextBrief(brief).split("\n")[1], brief.driftRead!.command);
  assert.match(formatContextBrief(brief), /Received Card sources changed/);
  assert.doesNotMatch(JSON.stringify(brief), /No output|ageSeconds|sinceUnknown/);
  assert.doesNotMatch(formatContextBrief(brief), /^Ahead:|^Behind:/m);
  const quiet = makeContextBrief({
    ...context,
    sync: { ...context.sync, nodes: [], counts: { synced: 0, ahead: 0, behind: 0, unanchored: 0 } },
    changedCardSources: { items: [], diagnostics: [] },
  });
  assert.equal(quiet.driftRead, undefined);
  assert.equal(formatContextBrief(quiet), "behind 0 · ahead 0");
});

test("brief keeps interleaved Card states in their original sorted order and preserves diagnostic totals", () => {
  const items = Array.from({ length: 12 }, (_, i) => [
    { cardId: `card-returned${i}`, state: "returned", returnTo: "role-requester" },
    { cardId: `card-consumed${i}`, state: "consumed", returnTo: "role-requester" },
    { cardId: `card-unknown${i}`, diagnostic: "Card header unavailable; inspect raw" },
  ])
    .flat()
    .map((item, i) => ({
      ...item,
      publishedAt: new Date(Date.UTC(2026, 9, 26, 12, 0, 60 - i)).toISOString(),
    }));
  const context: CurrentContext = {
    workspaceRoot: "D:/Tent",
    roots: [],
    sync: {
      invalidNodes: [],
      nodes: [],
      counts: { synced: 0, ahead: 0, behind: 0, unanchored: 0 },
      outputNodes: [],
      requirementsWithoutOutputs: [],
    },
    cards: { revision: "fixture", items },
    changedCardSources: { items: [], diagnostics: [{ message: "Source could not be compared" }] },
    recoveryConflicts: Array.from({ length: 12 }, (_, i) => `a/full recovery path ${i}.md`),
    draftCount: 3,
  };
  const brief = makeContextBrief(context, { roleId: "role-requester" });
  assert.deepEqual(
    brief.cardInputs.map((item) => item.cardId),
    items.slice(0, 30).map((item) => item.cardId),
  );
  assert.equal(brief.omitted.cardInputs, 6);
  assert.deepEqual(brief.consumedCardsRead, {
    total: 12,
    command: "tent card list --role role-requester --state consumed --workspace D:/Tent",
  });
  assert.deepEqual(brief.unknownCardsRead, {
    total: 12,
    command: "tent card list --role role-requester --workspace D:/Tent",
  });
  assert.equal(brief.cardSourcesUncertain, true);
  assert.deepEqual(brief.recoveryConflicts, context.recoveryConflicts);
  assert.deepEqual(brief.drafts, { count: 3, command: "tent node list --status draft" });
  const text = formatContextBrief(brief);
  assert.match(text, /3 条还没定 · tent node list --status draft/);
  for (const p of context.recoveryConflicts!) assert.ok(text.includes(`.tent/${p}`));
  for (const read of [brief.returnedCardsRead!, brief.consumedCardsRead!, brief.unknownCardsRead!])
    assert.ok(text.split("\n").includes(`+2 more: ${read.command}`));
});

test("CLI discovery text and JSON stay byte-identical when the clock advances one second", async (t) => {
  const f = await fixture(t);
  const created = await f.node("create", [
    "Requirement",
    "--type",
    "goal",
    "--body",
    "Unfulfilled",
  ]);
  const id = created.node.nodeId;
  await f.node("create", ["Context", "--type", "prompt", "--parent", id, "--body", "Details"]);
  const card = await runCardCommand(
    "create",
    ["--prompt", "Read requirement", "--source", id],
    f.options,
  );
  assert.equal(card.exitCode, 0, card.stderr);
  assert.ok((await f.node("check", [id])).ahead);
  const head = await historyHead(path.join(f.root, ".tent"));
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-07T04:00:59Z") });
  const readAll = async () => {
    const outputs: Record<string, string> = {};
    for (const json of [false, true]) {
      const options = { workspace: f.root, json };
      const calls = [
        ["brief", () => runWorkspaceCommand("brief", [], options)],
        ["drift", () => runWorkspaceCommand("drift", [], options)],
        ["card list", () => runCardCommand("list", [], options)],
        ["node get", () => runNodeCommand("get", [id, "--full"], options)],
        ["node list", () => runNodeCommand("list", [], options)],
        [
          "node relations",
          () => runNodeCommand("relations", [id, "--direction", "children"], options),
        ],
      ] as const;
      for (const [name, read] of calls) {
        const result = await read();
        assert.equal(result.exitCode, 0, `${name}: ${result.stderr}`);
        outputs[`${name} ${json ? "json" : "text"}`] = result.stdout;
      }
    }
    return outputs;
  };
  const before = await readAll();
  const brief = JSON.parse(before["brief json"]);
  assert.deepEqual(brief.ahead, []);
  assert.equal(brief.counts.ahead, 1);
  assert.equal(brief.driftRead.command, `tent workspace drift --workspace ${f.root}`);
  assert.ok(before["brief text"].includes(brief.driftRead.command));
  assert.equal(JSON.parse(before["card list json"]).items.length, 1);
  assert.ok(
    JSON.parse(before["drift json"]).items.some(
      (item: { kind: string }) => item.kind === "node-ahead",
    ),
  );
  assert.equal(JSON.parse(before["node relations json"]).items.length, 1);
  t.mock.timers.tick(1000);
  const after = await readAll();
  for (const name of Object.keys(before)) assert.equal(after[name], before[name], name);
  assert.equal(await historyHead(path.join(f.root, ".tent")), head);
});

test("brief counts a dual-status goal while drift lists both findings and leaves neutral output quiet", () => {
  const context: CurrentContext = {
    roots: [],
    sync: {
      invalidNodes: [],
      nodes: [
        {
          nodeId: "node-goal",
          path: "Goal",
          type: "goal",
          state: "behind",
          trustTier: "unverified",
          stale: false,
          materials: [],
          reasons: ["Material changed", "No output"],
          behind: { reasons: ["Material changed"] },
          ahead: { reasons: ["No output"] },
        },
        {
          nodeId: "node-quiet",
          path: "Evidence",
          type: "output",
          resource: "../../evidence.svg",
          state: "synced",
          trustTier: "unverified",
          stale: false,
          materials: [],
          reasons: [],
        },
      ],
      counts: { synced: 1, unanchored: 0, ahead: 1, behind: 1 },
      outputNodes: [{ nodeId: "node-quiet", path: "Evidence", resource: "../../evidence.svg" }],
      requirementsWithoutOutputs: ["node-goal"],
    },
    cards: { revision: "r", items: [] },
    changedCardSources: { items: [], diagnostics: [] },
  };
  const brief = makeContextBrief(context);
  assert.deepEqual(brief.counts, { ahead: 1, behind: 1 });
  assert.deepEqual(brief.behind, []);
  assert.deepEqual(brief.ahead, []);
  const text = formatContextBrief(brief);
  assert.match(text, /^behind 1 · ahead 1\ntent workspace drift --workspace/);
  assert.doesNotMatch(text, /Ahead:|Behind:|node-goal|Material changed|No output/);
  assert.doesNotMatch(text, /start time not recorded/);
  assert.doesNotMatch(text, /node-quiet|Recent inputs|Recent outputs|synced/);
  assert.deepEqual(
    contextDriftItems(context).map((item) => [item.kind, item.nodeId]),
    [
      ["node-behind", "node-goal"],
      ["node-ahead", "node-goal"],
    ],
  );
  const materials: CurrentContext["sync"]["nodes"][number]["materials"] = [
    {
      resource: "../../src/",
      track: "structure",
      goalId: "node-parent",
      state: "changed",
      recordedVersion: "old-structure",
      currentVersion: "new-structure",
      reason: "External dependencies changed",
      changedDependencies: [
        { target: "old/", state: "deleted" },
        { target: "new/", state: "added" },
      ],
      changedDependenciesOverflow: 3,
    },
    { resource: "../../missing.md", state: "unavailable", reason: "ENOENT" },
    { resource: "External discussion", state: "unanchored" },
    {
      resource: "../../current.md",
      state: "current",
      recordedVersion: "same",
      currentVersion: "same",
    },
  ];
  context.sync.nodes[0]!.materials = materials;
  const detailed = contextDriftItems(context);
  assert.equal(detailed.length, 2);
  const behind = detailed.find((item) => item.kind === "node-behind")!;
  assert.deepEqual(behind.materials, materials);
  assert.deepEqual(JSON.parse(JSON.stringify(behind)).materials, materials);
  assert.equal("materials" in detailed.find((item) => item.kind === "node-ahead")!, false);
  assert.deepEqual(makeContextBrief(context), brief, "drift details do not consume brief budget");
});
