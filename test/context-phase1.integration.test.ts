import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { runCardCommand } from "../src/cli/card-commands.js";
import { git } from "./helpers.js";
import { appendSessionObservations } from "../src/core/session-observations.js";
import { observeSessionFile } from "../src/fs/session-observations.js";
import { parseFrontmatter } from "../src/core/frontmatter.js";
import {
  inspectCurrentContext,
  makeContextBrief,
  formatContextBrief,
  findUnlinkedOutputs,
  contextDriftItems,
  type CurrentContext,
} from "../src/core/context-brief.js";
import type { FsAdapter } from "../src/core/adapter.js";
import { loadNodeCatalog } from "../src/core/node-catalog.js";

test("brief reports native capture failure without unhandled unused Card query promises", async () => {
  const adapter = {
    exists: async () => false,
    listDir: async () => [],
  } as unknown as FsAdapter;
  const failure = new Error("capture failed");
  await assert.rejects(
    inspectCurrentContext(adapter, ".", { nodes: Promise.reject(failure) }),
    (error) => error === failure,
  );
  // Node's test runner reports any unhandled rejection from unused query branches.
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("brief never hides invalid files or pending Cards and folds only missing-baseline debt", () => {
  const pending = Array.from({ length: 40 }, (_, i) => ({
    cardId: `card-pending${i}`,
    state: "pending",
    title: "待接收的工作".repeat(8),
    ...(i === 0 ? { diagnostic: "Source unavailable" } : {}),
  }));
  const invalidNodes = Array.from({ length: 10 }, (_, i) => ({
    path: `.tent/${"很长的实际目录".repeat(30)}/${i}.md`,
    reason: "Invalid frontmatter",
  }));
  const context: CurrentContext = {
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
    observations: { events: [], uncertain: false },
    cards: { revision: "fixture", items: pending },
    changedCardSources: { items: [], diagnostics: [] },
    unlinkedOutputs: [],
  };
  const brief = makeContextBrief(context);
  const withoutRoots = makeContextBrief({ ...context, roots: [] });
  assert.deepEqual(brief.cardInputs, withoutRoots.cardInputs);
  assert.deepEqual(brief.ahead, withoutRoots.ahead);
  assert.deepEqual(brief.behind, withoutRoots.behind);
  assert.equal(brief.roots.length, 12);
  assert.equal(brief.omitted.roots, 1);
  assert.deepEqual(Object.keys(brief).slice(0, 5), [
    "counts",
    "invalidNodes",
    "cardInputs",
    "ahead",
    "changedCardSources",
  ]);
  assert.equal(brief.cardInputs.length, pending.length);
  assert.equal(brief.omitted.cardInputs, 0);
  assert.deepEqual(brief.invalidNodes, invalidNodes);
  assert.equal(brief.baselineOnlyBehind, 1);
  assert.deepEqual(brief.behind, []);
  const text = formatContextBrief(brief);
  assert.ok(text.indexOf("Root Nodes:") > text.indexOf("Input Cards"));
  assert.match(text, /\+1 more · tent node list$/);
  assert.ok(
    Buffer.byteLength(text) > 4096,
    "mandatory actionable information may exceed the optional detail budget",
  );
  assert.equal(text.split("\n")[1], "Invalid Nodes:");
  for (const item of invalidNodes) assert.ok(text.includes(item.path));
  for (const card of pending) assert.ok(text.includes(`.tent/cards/${card.cardId}.md`));
  assert.match(text, /1 behind Nodes have no retained baseline.*tent workspace drift --json/);
});

async function fixture(t: TestContext) {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "context-phase1-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
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

test("brief exposes live root entry files without drift or another catalog scan", async (t) => {
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
  const adapter = new NodeFs(path.join(f.root, ".tent"));
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
  const context = await inspectCurrentContext(observed, f.root, {
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
      path: created.results[index].path,
    })),
  );
  for (const root of brief.roots) assert.ok((await fs.stat(path.join(f.root, root.path))).isFile());
  const cli = await f.workspace("brief");
  assert.deepEqual(cli.value.roots, brief.roots);
  const text = await runWorkspaceCommand("brief", [], { workspace: f.root });
  assert.equal(text.exitCode, 0, text.stderr);
  assert.match(text.stdout, /Map \[prompt\] \.tent\/Map\/Map.md/);
  assert.doesNotMatch(text.stdout, /Archived|Core\/Core.md/);
});

test("without Hooks the complete requirement, output, drift, review and unanchored-decision scenario works", async (t) => {
  const f = await fixture(t);
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
  assert.ok(ahead.aheadSince);
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
  const headBefore = await git(path.join(f.root, ".tent"), "rev-parse", "HEAD");
  let brief = await f.workspace("brief");
  assert.equal(brief.value.counts.behind, 2);
  assert.deepEqual(
    brief.value.behind.map((item: { nodeId: string }) => item.nodeId).sort(),
    [id, linked.nodeId].sort(),
  );
  assert.ok(Buffer.byteLength(brief.stdout) <= 4096);
  let drift = (await f.workspace("drift")).value;
  assert.equal(
    drift.items.some((item: { kind: string }) => item.kind === "unlinked-output"),
    false,
  );
  assert.equal(
    await git(path.join(f.root, ".tent"), "rev-parse", "HEAD"),
    headBefore,
    "read-only commands must not capture a new version",
  );
  let read = await f.node("get", [id, "--full"]);
  await f.node("confirm", [id, "--base-etag", read.etag]);
  assert.equal((await f.node("check", [id])).state, "ahead");
  assert.equal((await f.node("check", [linked.nodeId])).state, "behind");
  const outputRead = await f.node("get", [linked.nodeId, "--full"]);
  await f.node("confirm", [linked.nodeId, "--base-etag", outputRead.etag]);
  assert.equal((await f.node("check", [id])).state, "synced");
  read = await f.node("get", [id, "--full"]);
  await f.node("write", [id, "--body", "Changed confirmed requirement", "--base-etag", read.etag]);
  assert.equal((await f.node("check", [id])).state, "ahead");
  assert.equal((await f.node("check", [linked.nodeId])).state, "behind");
  drift = (await f.workspace("drift")).value;
  assert.ok(
    drift.items.some(
      (item: { kind: string; nodeId?: string }) =>
        item.kind === "node-behind" && item.nodeId === linked.nodeId,
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
  await fs.writeFile(path.join(f.root, "loose.svg"), "<svg/>");
  const adapter = new NodeFs(path.join(f.root, ".tent"));
  await appendSessionObservations(
    adapter,
    "output-session",
    "one",
    {
      observations: [{ kind: "written", address: "loose.svg" }],
      signals: [],
      uncertain: false,
    },
    (address) => observeSessionFile(f.root, address),
  );
  brief = await f.workspace("brief");
  assert.ok(
    brief.value.unlinkedOutputs.some((item: { address?: string }) => item.address === "loose.svg"),
  );
  await f.node("create", [
    "Loose output",
    "--type",
    "output",
    "--tags",
    "asset",
    "--resource",
    "loose.svg",
  ]);
  brief = await f.workspace("brief");
  assert.deepEqual(brief.value.unlinkedOutputs, []);
  drift = (await f.workspace("drift")).value;
  assert.equal(
    drift.items.some((item: { kind: string }) => item.kind === "unlinked-output"),
    false,
  );
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

test("brief shows multi-goal Card completion and only warns for changed source goals still ahead", async (t) => {
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
  const published = await card("create", [
    "--prompt",
    "Implement the source.",
    "--source",
    source.node.nodeId,
    "--source",
    second.node.nodeId,
  ]);
  await card("take", [published.cardId]);
  const received = (await f.workspace("brief")).value;
  assert.deepEqual(received.changedCardSources, []);
  assert.equal(received.cardInputs[0].progress, "received-no-output");
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
  assert.equal(withOutput.cardInputs[0].progress, "received-no-output");
  assert.equal(withOutput.cardInputs[0].outputCount, 1);
  assert.equal(withOutput.cardInputs[0].goalCount, 1);
  assert.equal(withOutput.cardInputs[0].totalGoalCount, 2);
  const textBrief = await runWorkspaceCommand("brief", [], { workspace: f.root });
  assert.equal(textBrief.exitCode, 0, textBrief.stderr);
  assert.match(textBrief.stdout, /\[received-no-output 1\/2\]/);
  const file = path.join(f.root, ".tent", "Spec", "Spec.md");
  const original = await fs.readFile(file, "utf8");
  await fs.writeFile(file, original.replace("Original requirement", "Changed requirement"));
  const head = await git(path.join(f.root, ".tent"), "rev-parse", "HEAD");
  const brief = await f.workspace("brief");
  assert.equal(brief.value.changedCardSources[0].cardId, published.cardId);
  assert.equal(brief.value.changedCardSources[0].nodeId, source.node.nodeId);
  assert.equal(brief.value.changedCardSources[0].state, "changed");
  assert.notEqual(
    await git(path.join(f.root, ".tent"), "rev-parse", "HEAD"),
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
  assert.deepEqual(
    (await f.workspace("brief")).value.cardInputs,
    [],
    "fully completed Cards leave pending work",
  );
  const shown = await card("show", [published.cardId]);
  await card("deprecate", [published.cardId, "--base-etag", shown.etag]);
  const after = (await f.workspace("brief")).value;
  assert.deepEqual(after.changedCardSources, []);
  assert.deepEqual(after.cardInputs, []);
});

test("a Unicode-heavy brief stays within 4 KiB in both forms and retains counts and complete identities", () => {
  const nodes = Array.from({ length: 100 }, (_, i) => ({
    nodeId: `node-${i}`,
    path: i === 1 ? "Short" : `一个很长的名字${"非常长".repeat(200)}`,
    type: "goal",
    state: (i % 2 ? "ahead" : "behind") as "ahead" | "behind",
    trustTier: "unverified" as const,
    stale: false,
    aheadSince: "2026-01-01T00:00:00.000Z",
    ...(i % 2
      ? { ahead: { since: "2026-01-01T00:00:00.000Z", reasons: ["No output"] } }
      : { behind: { reasons: ["材料变化".repeat(100)] } }),
    materials: [],
    reasons: ["材料变化".repeat(100)],
  }));
  const context: CurrentContext = {
    roots: [],
    sync: {
      invalidNodes: [],
      nodes,
      counts: { synced: 0, ahead: 50, behind: 50, unanchored: 9 },
      outputNodes: [],
      requirementsWithoutOutputs: [],
    },
    observations: {
      events: [
        {
          schema: 1,
          type: "turn",
          sessionId: "large",
          turnId: "one",
          observedAt: "2026-02-01T00:00:00.000Z",
          files: [
            {
              kind: "written",
              address: "输出".repeat(5000),
              version: {
                state: "uncertain",
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
    changedCardSources: {
      items: Array.from({ length: 50 }, (_, i) => ({
        cardId: `card-${i}`,
        nodeId: `node-${i}`,
        resource: `/Source${i}/Source${i}.md`,
        state: "changed" as const,
        publishedVersion: { commit: "a".repeat(40), path: `Source${i}/Source${i}.md` },
        reason: "来源材料变化".repeat(100),
      })),
      diagnostics: [],
    },
    unlinkedOutputs: [
      { address: "输出".repeat(5000), observedAt: "2026-02-01T00:00:00.000Z", sessionId: "large" },
    ],
  };
  const brief = makeContextBrief(context);
  assert.deepEqual(brief.counts, { ahead: 50, behind: 50 });
  assert.ok(Buffer.byteLength(JSON.stringify(brief) + "\n") <= 4096);
  assert.ok(Buffer.byteLength(formatContextBrief(brief) + "\n") <= 4096);
  assert.match(formatContextBrief(brief).split("\n")[0], /^behind 50 · ahead 50$/);
  assert.ok(brief.omitted.behind > 0 && brief.omitted.ahead > 0);
  assert.ok(brief.omitted.changedCardSources > 0);
  assert.match(formatContextBrief(brief), /Received Card sources changed/);
  assert.equal(
    brief.unlinkedOutputs.length,
    0,
    "an address never becomes a misleading truncated path",
  );
  assert.equal(brief.ahead[0].since, "2026-01-01T00:00:00.000Z");
  assert.equal("ageSeconds" in brief.ahead[0], false);
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
  const since = (await f.node("check", [id])).ahead.since;
  assert.ok(since, "fixture must expose a known ahead start time");
  const head = await git(path.join(f.root, ".tent"), "rev-parse", "HEAD");
  // Crossing 59s -> 1m catches both the old JSON age and the text formatAge boundary.
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(since) + 59_000 });
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
  assert.equal(brief.ahead[0].since, since);
  assert.equal("ageSeconds" in brief.ahead[0], false);
  assert.ok(before["brief text"].includes(`since ${since}`));
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
  assert.equal(await git(path.join(f.root, ".tent"), "rev-parse", "HEAD"), head);
});

test("brief counts historical unrecorded files but only lists three recent sessions", () => {
  const times = ["2026-02-01", "2026-01-31", "2026-01-30", "2026-01-29", "2026-01-01"];
  const events = times.map((day, index) => ({
    schema: 1 as const,
    type: "turn" as const,
    sessionId: `session-${index}`,
    turnId: "turn-1",
    observedAt: `${day}T00:00:00.000Z`,
    files: [
      {
        kind: "written" as const,
        address: `file-${index}.md`,
        version: {
          state: "uncertain" as const,
          phase: "stop" as const,
          observedAt: `${day}T00:00:00.000Z`,
        },
      },
    ],
    signals: [],
    uncertain: false,
  }));
  const context: CurrentContext = {
    roots: [],
    sync: {
      invalidNodes: [],
      nodes: [],
      counts: { synced: 0, ahead: 0, behind: 0, unanchored: 0 },
      outputNodes: [],
      requirementsWithoutOutputs: [],
    },
    observations: { events, uncertain: false },
    cards: { revision: "r", items: [] },
    changedCardSources: { items: [], diagnostics: [] },
    unlinkedOutputs: [
      ...events.map((event, index) => ({
        address: `file-${index}.md`,
        observedAt: event.observedAt,
        sessionId: event.sessionId,
      })),
    ],
  };
  const brief = makeContextBrief(context);
  assert.deepEqual(
    new Set(brief.unlinkedOutputs.map((item) => item.nodeId ?? item.address)),
    new Set(["file-0.md", "file-1.md", "file-2.md"]),
  );
  assert.equal(brief.omitted.unlinkedOutputs, 2);
  assert.match(formatContextBrief(brief), /2 older or omitted unrecorded files/);
  assert.equal(context.unlinkedOutputs.length, 5, "the full observation source remains intact");
});

test("brief's inclusive seven-day window follows the latest observed write, not the clock or reads", (t) => {
  const observedAt = "2026-02-20T00:00:00.000Z";
  const files = [
    { address: "latest-linked.md", kind: "written" as const, at: "2026-02-08T00:00:00.000Z" },
    { address: "middle.md", kind: "written" as const, at: "2026-02-03T00:00:00.000Z" },
    { address: "boundary.md", kind: "written" as const, at: "2026-02-01T00:00:00.000Z" },
    { address: "too-old.md", kind: "written" as const, at: "2026-01-31T23:59:59.999Z" },
    { address: "latest-read.md", kind: "read" as const, at: observedAt },
  ];
  const context: CurrentContext = {
    roots: [],
    sync: {
      invalidNodes: [],
      nodes: [],
      counts: { synced: 0, ahead: 0, behind: 0, unanchored: 0 },
      outputNodes: [{ nodeId: "node-linked", path: "Linked", resource: "../../latest-linked.md" }],
      requirementsWithoutOutputs: [],
    },
    observations: {
      events: [
        {
          schema: 1,
          type: "turn",
          sessionId: "boundary",
          turnId: "one",
          observedAt,
          files: files.map(({ address, kind, at }) => ({
            address,
            kind,
            version: { state: "uncertain", phase: "stop", observedAt: at },
          })),
          signals: [],
          uncertain: false,
        },
      ],
      uncertain: false,
    },
    cards: { revision: "r", items: [] },
    changedCardSources: { items: [], diagnostics: [] },
    unlinkedOutputs: [],
  };
  context.unlinkedOutputs = findUnlinkedOutputs(
    context.sync,
    context.observations.events,
    process.cwd(),
  );
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-02-08T00:00:00.000Z") - 1000 });
  const before = makeContextBrief(context);
  assert.deepEqual(
    before.unlinkedOutputs.map((item) => item.address),
    ["middle.md", "boundary.md"],
  );
  assert.equal(before.omitted.unlinkedOutputs, 1);
  t.mock.timers.tick(2000);
  const after = makeContextBrief(context);
  assert.equal(JSON.stringify(after), JSON.stringify(before));
  assert.equal(formatContextBrief(after), formatContextBrief(before));
  context.sync.outputNodes = [];
  context.unlinkedOutputs = findUnlinkedOutputs(
    context.sync,
    context.observations.events,
    process.cwd(),
  );
  assert.deepEqual(
    makeContextBrief(context).unlinkedOutputs.map((item) => item.address),
    ["latest-linked.md", "middle.md", "boundary.md"],
  );
  context.observations.events[0]!.files = context.observations.events[0]!.files.filter(
    (file) => file.kind === "read",
  );
  context.unlinkedOutputs = findUnlinkedOutputs(
    context.sync,
    context.observations.events,
    process.cwd(),
  );
  assert.deepEqual(makeContextBrief(context).unlinkedOutputs, []);
  context.observations.events = [];
  assert.deepEqual(makeContextBrief(context).unlinkedOutputs, []);
});

test("brief and drift both show a dual-status goal and leave neutral recorded output quiet", () => {
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
    observations: { events: [], uncertain: false },
    cards: { revision: "r", items: [] },
    changedCardSources: { items: [], diagnostics: [] },
    unlinkedOutputs: [],
  };
  const brief = makeContextBrief(context);
  assert.deepEqual(brief.counts, { ahead: 1, behind: 1 });
  assert.deepEqual(
    brief.behind.map((item) => item.nodeId),
    ["node-goal"],
  );
  assert.deepEqual(
    brief.ahead.map((item) => item.nodeId),
    ["node-goal"],
  );
  assert.equal(brief.behind[0]!.reason, "Material changed");
  const text = formatContextBrief(brief);
  assert.match(text, /^behind 1 · ahead 1\nAhead:/);
  assert.ok(text.indexOf("Ahead:") < text.indexOf("Behind:"));
  assert.match(text, /start time not recorded/);
  assert.doesNotMatch(text, /node-quiet|Recent inputs|Recent outputs|synced/);
  assert.deepEqual(
    contextDriftItems(context).map((item) => [item.kind, item.nodeId]),
    [
      ["node-behind", "node-goal"],
      ["node-ahead", "node-goal"],
    ],
  );
});

test("uncertain Node associations never become a definite unlinked file claim", () => {
  const context: CurrentContext = {
    roots: [],
    sync: {
      invalidNodes: [],
      nodes: [
        {
          nodeId: "node-racing",
          path: "Racing",
          type: "goal",
          state: "unanchored",
          trustTier: "unverified",
          stale: false,
          uncertain: true,
          materials: [],
          reasons: ["Node changed during inspection"],
        },
      ],
      counts: { synced: 0, ahead: 0, behind: 0, unanchored: 1 },
      outputNodes: [],
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
    changedCardSources: { items: [], diagnostics: [] },
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
