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
  type CurrentContext,
} from "../src/core/read/context-brief.js";
import type { FsAdapter } from "../src/core/store/adapter.js";
import { loadNodeCatalog } from "../src/core/graph/node-catalog.js";
import { formatAgentBrief, type AgentBrief } from "../src/core/read/agent-brief.js";

const briefCards = (brief: AgentBrief) =>
  brief.agentContext.sections.find((section) => section.kind === "open")!.items;
const briefIssues = (brief: AgentBrief, kind: string) =>
  brief.workspaceIssues.items.filter((item) => item.kind === kind);

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
    invalidNodes,
    cards: {
      revision: "fixture",
      items: [
        ...pending,
        ...returned,
        {
          cardId: "card-unknown",
          diagnostic: "Card header unavailable; inspect raw",
        },
      ],
    },
    changedCardSources: {
      items: [],
      diagnostics: [{ message: "Could not compare" }],
    },
    recoveryConflicts: ["a/complete recovery path.md"],
  };
  const brief = makeContextBrief(context);
  const withoutRoots = makeContextBrief({ ...context, roots: [] });
  assert.deepEqual(brief.cardInputs, withoutRoots.cardInputs);
  assert.equal(brief.roots.length, 10);
  assert.equal(brief.omitted.roots, 3);
  assert.deepEqual(Object.keys(brief).slice(0, 4), [
    "invalidNodes",
    "cardInputs",
    "changedCardSources",
    "roots",
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
  assert.deepEqual(brief.roots[0], {
    nodeId: "node-root0",
    name: "Root 0",
    type: "prompt",
  });
  assert.equal(brief.cardSourcesUncertain, true);
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
  const scoped = makeContextBrief(context, { roleId: "role-requester" });
  assert.equal(
    scoped.pendingCardsRead!.command,
    "tent card list --role role-requester --include-open --state pending --workspace 'D:/Workspace with spaces/Tent'",
  );
  assert.equal(
    scoped.returnedCardsRead!.command,
    "tent card list --role role-requester --state returned --workspace 'D:/Workspace with spaces/Tent'",
  );
});

async function fixture(t: TestContext) {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "context-phase1-"));
  t.after(() =>
    removeTestFixture(root, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 200,
    }),
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
  assert.equal("unlinkedOutputs" in brief.workspaceIssues, false);
  assert.doesNotMatch(formatAgentBrief(brief), /unrecorded|Session observations/);
  assert.equal(await read.call(adapter, legacy), "invalid old session log\n");
});

test("brief exposes root identities without another catalog scan", async (t) => {
  const f = await fixture(t);
  const created = await f.node("write-many", ["--input-json", "-"], {
    items: [
      {
        op: "create",
        ref: "map",
        name: "Map",
        type: "prompt",
        body: "Module map",
      },
      {
        op: "create",
        ref: "core",
        parent: "@map",
        name: "Core",
        type: "prompt",
        body: "Core module",
      },
      {
        op: "create",
        ref: "other",
        name: "Other",
        type: "prompt",
        body: "Other entry",
      },
      {
        op: "create",
        ref: "archived",
        name: "Archived",
        type: "prompt",
        body: "Old entry",
      },
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
  assert.deepEqual(
    brief.roots,
    [0, 2].map((index) => ({
      nodeId: created.results[index].nodeId,
      name: index === 0 ? "Map" : "Other",
      type: "prompt",
    })),
  );
  const cli = await f.workspace("brief");
  assert.equal("roots" in cli.value, false);
  assert.ok(
    cli.value.agentContext.sourceReads.some((read: { command?: string }) =>
      read.command?.includes("node list --full"),
    ),
  );
  const listed = await f.node("list", []);
  assert.deepEqual(
    listed.items.map(({ nodeId, name, type }: { nodeId: string; name: string; type: string }) => ({
      nodeId,
      name,
      type,
    })),
    brief.roots,
  );
  const text = await runWorkspaceCommand("brief", [], { workspace: f.root });
  assert.equal(text.exitCode, 0, text.stderr);
  assert.ok(text.stdout.includes(created.results[0].nodeId));
  assert.doesNotMatch(text.stdout, /Archived|Core\/Core.md/);
});

test("without Hooks requirements and outputs keep paths, content, and read-only history", async (t) => {
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
    "Settled requirement",
  ]);
  const id = created.node.nodeId;
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
  await fs.writeFile(path.join(f.root, "requirement.md"), "Requirement version two");
  const headBefore = await historyHead(path.join(f.root, ".tent"));
  const brief = await f.workspace("brief");
  assert.ok(Buffer.byteLength(brief.stdout) <= 16384);
  const read = await f.node("get", [id, "--full"]);
  assert.equal(read.text, "Settled requirement\n");
  assert.equal(await historyHead(path.join(f.root, ".tent")), headBefore);
  await f.node("write", [id, "--body", "Changed requirement", "--base-etag", read.etag]);
  assert.equal((await f.node("get", [id, "--full"])).text, "Changed requirement");
  const output = await f.node("get", [linked.nodeId, "--full"]);
  await f.node("write", [
    linked.nodeId,
    "--body",
    "Updated implementation",
    "--base-etag",
    output.etag,
  ]);
  assert.equal((await f.node("get", [linked.nodeId, "--full"])).text, "Updated implementation");
  const decision = await f.node("create", [
    "Conversation decision",
    "--type",
    "prompt",
    "--body",
    "A decision made in conversation",
  ]);
  const after = (await f.workspace("brief")).value;
  assert.ok(
    after.agentContext.sections
      .find((section: { kind: string }) => section.kind === "references")
      .items.some((item: { nodeId: string }) => item.nodeId === decision.node.nodeId),
  );
});

test("brief keeps Card delivery independent of outputs and retains changed source facts", async (t) => {
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
  assert.deepEqual(briefIssues(received, "changed-source"), []);
  assert.equal(briefCards(received)[0]!.state, "consumed");
  const reception = await card("show", [published.cardId]);
  assert.equal(reception.receivedBy, "role-worker");
  assert.equal(reception.returnTo, "role-requester");
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
  assert.deepEqual(briefCards(withOutput), briefCards(received));
  for (const key of [
    "progress",
    "outputCount",
    "goalCount",
    "totalGoalCount",
    "outputNodeIds",
    "reviewOutputNodeIds",
  ])
    assert.equal(key in briefCards(withOutput)[0]!, false);
  const textBrief = await runWorkspaceCommand("brief", [], {
    workspace: f.root,
  });
  assert.equal(textBrief.exitCode, 0, textBrief.stderr);
  assert.match(textBrief.stdout, new RegExp(`${published.cardId} consumed`));
  assert.match(textBrief.stdout, /reception\/return details are in the Card reads below/);
  assert.doesNotMatch(textBrief.stdout, /received-no-output|has-output|needs-review|1\/2/);
  const file = path.join(f.root, ".tent", "Spec", "Spec.md");
  const original = await fs.readFile(file, "utf8");
  await fs.writeFile(file, original.replace("Original requirement", "Changed requirement"));
  const head = await historyHead(path.join(f.root, ".tent"));
  const brief = await f.workspace("brief");
  const changedSource = briefIssues(brief.value, "changed-source")[0]!;
  assert.equal(changedSource.cardId, published.cardId);
  assert.equal(changedSource.nodeId, source.node.nodeId);
  assert.notEqual(
    await historyHead(path.join(f.root, ".tent")),
    head,
    "brief records the preceding native source edit",
  );
  await f.node("link-output", [
    source.node.nodeId,
    "--resource",
    "result.html",
    "--card",
    published.cardId,
  ]);
  assert.deepEqual(
    briefIssues((await f.workspace("brief")).value, "changed-source"),
    [changedSource],
    "a later output does not erase the changed pinned Card source",
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
    briefCards(allOutputs),
    briefCards(received),
    "goal outputs do not complete the Card",
  );
  assert.deepEqual(briefIssues(allOutputs, "changed-source"), [changedSource]);
  await card("return", [
    published.cardId,
    "--role",
    "role-worker",
    "--result",
    `Done ${output.nodeId}`,
  ]);
  const returned = (await f.workspace("brief", ["--role", "role-requester"])).value;
  assert.equal(briefCards(returned)[0]!.state, "returned");
  assert.equal("result" in briefCards(returned)[0]!, false);
  assert.equal((await card("show", [published.cardId])).result, `Done ${output.nodeId}`);
  assert.deepEqual(briefCards((await f.workspace("brief", ["--role", "role-worker"])).value), []);
  assert.deepEqual(
    briefCards((await f.workspace("brief", ["--role", "role-requester"])).value),
    briefCards(returned),
  );
  await card("take", [published.cardId, "--role", "role-requester"]);
  assert.deepEqual(
    briefCards((await f.workspace("brief")).value),
    [],
    "taking the receipt closes its delivery",
  );
  const notice = await card("create", ["--prompt", "Read this", "--source", second.node.nodeId]);
  await card("take", [notice.cardId]);
  assert.deepEqual(
    briefCards((await f.workspace("brief")).value),
    [],
    "a Card without returnTo completes on take",
  );
  const shown = await card("show", [published.cardId]);
  await card("deprecate", [published.cardId, "--base-etag", shown.etag]);
  const after = (await f.workspace("brief")).value;
  assert.deepEqual(briefIssues(after, "changed-source"), []);
  assert.deepEqual(briefCards(after), []);
});

test("brief bounds changed Card source discovery without a byte cap", () => {
  const context: CurrentContext = {
    workspaceRoot: "D:/Frozen Tent",
    roots: [],
    invalidNodes: [],
    cards: { revision: "r", items: [] },
    changedCardSources: {
      items: Array.from({ length: 50 }, (_, i) => ({
        cardId: `card-${i}`,
        nodeId: `node-${i}`,
        resource: `/Source${i}/Source${i}.md`,
        state: "changed" as const,
        publishedVersion: {
          commit: "a".repeat(64),
          path: `Source${i}/Source${i}.md`,
        },
        path: `${"完整的来源目录".repeat(100)}/${i}.md`,
        reason: "来源材料变化".repeat(100),
      })),
      diagnostics: [],
    },
  };
  const brief = makeContextBrief(context);
  assert.ok(Buffer.byteLength(JSON.stringify(brief) + "\n") > 4096);
  assert.ok(Buffer.byteLength(formatContextBrief(brief) + "\n") > 4096);
  assert.deepEqual(
    brief.changedCardSources.map((item) => item.nodeId),
    Array.from({ length: 10 }, (_, i) => `node-${i}`),
  );
  assert.equal(brief.omitted.changedCardSources, 40);
  assert.deepEqual(brief.changedCardSourcesRead, {
    total: 50,
    command: "tent card list --state consumed --workspace 'D:/Frozen Tent'",
  });
  assert.equal(
    brief.changedCardSources[0].path,
    `.tent/${context.changedCardSources.items[0].path}`,
  );
  const read = brief.changedCardSourcesRead!;
  assert.ok(
    formatContextBrief(brief)
      .split("\n")
      .includes(`+${read.total - 10} more: ${read.command}`),
  );
  assert.match(formatContextBrief(brief), /Received Card sources changed/);
  assert.doesNotMatch(JSON.stringify(brief), /No output|ageSeconds|sinceUnknown/);
  assert.doesNotMatch(formatContextBrief(brief), /^Ahead:|^Behind:/m);
  const quiet = makeContextBrief({
    ...context,
    changedCardSources: { items: [], diagnostics: [] },
  });
  assert.equal(formatContextBrief(quiet), "");
});

test("brief keeps interleaved Card states in their original sorted order and preserves diagnostic totals", () => {
  const items = Array.from({ length: 12 }, (_, i) => [
    {
      cardId: `card-returned${i}`,
      state: "returned",
      returnTo: "role-requester",
    },
    {
      cardId: `card-consumed${i}`,
      state: "consumed",
      returnTo: "role-requester",
    },
    {
      cardId: `card-unknown${i}`,
      diagnostic: "Card header unavailable; inspect raw",
    },
  ])
    .flat()
    .map((item, i) => ({
      ...item,
      publishedAt: new Date(Date.UTC(2026, 9, 26, 12, 0, 60 - i)).toISOString(),
    }));
  const context: CurrentContext = {
    workspaceRoot: "D:/Tent",
    roots: [],
    invalidNodes: [],
    cards: { revision: "fixture", items },
    changedCardSources: {
      items: [],
      diagnostics: [{ message: "Source could not be compared" }],
    },
    recoveryConflicts: Array.from({ length: 12 }, (_, i) => `a/full recovery path ${i}.md`),
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
  assert.equal("drafts" in brief, false);
  const text = formatContextBrief(brief);
  assert.doesNotMatch(text, /还没定|--status draft/);
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
  const head = await historyHead(path.join(f.root, ".tent"));
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2026-10-07T04:00:59Z"),
  });
  const readAll = async () => {
    const outputs: Record<string, string> = {};
    for (const json of [false, true]) {
      const options = { workspace: f.root, json };
      const calls = [
        ["brief", () => runWorkspaceCommand("brief", [], options)],
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
  assert.equal("counts" in brief, false);
  assert.deepEqual(brief.workspaceIssues.items, []);
  assert.equal(JSON.parse(before["card list json"]).items.length, 1);
  assert.equal(JSON.parse(before["node relations json"]).items.length, 1);
  t.mock.timers.tick(1000);
  const after = await readAll();
  for (const name of Object.keys(before)) assert.equal(after[name], before[name], name);
  assert.equal(await historyHead(path.join(f.root, ".tent")), head);
});
