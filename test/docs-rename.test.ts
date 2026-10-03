import assert from "node:assert/strict";
import { NODE_MOVE_PENDING_PATH } from "../src/core/node-move-recovery.js";
import * as fs from "node:fs/promises";
import { testScratchRoot } from "./scratch.js";
import * as path from "node:path";
import { test } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import type { FsAdapter } from "../src/core/adapter.js";
import { createNode, renameNode } from "../src/core/ops.js";
import { loadTent } from "../src/core/tree.js";
import { loadOrder, saveOrder, ROOT_KEY } from "../src/core/order.js";
import { scaffoldInWorkspace, scaffoldTent } from "../src/core/scaffold.js";
import { buildNodeIndex } from "../src/core/okf.js";
import { rewriteNodeLinks } from "../src/core/rename-ops.js";
import {
  extractOutLinksDetailed as extractOutLinks,
  resolveOutLink,
} from "../src/markdown/links.js";

for (const reference of ["stable-id", "definition"] as const) {
  test(`renameNode: preserves resolved ${reference} references with a colliding new name`, async () => {
    const dir = await fs.mkdtemp(path.join(testScratchRoot(), "tent-rename-reference-"));
    const fsa = new NodeFs(dir);
    await scaffoldTent(fsa, { name: "x" });
    const env = envFor(fsa);
    await createNode(env, { parentPath: "", name: "branch-a", type: "prompt" });
    await createNode(env, { parentPath: "", name: "branch-b", type: "prompt" });
    const target = await createNode(env, { parentPath: "branch-a", name: "old", type: "prompt" });
    await createNode(env, { parentPath: "branch-b", name: "new", type: "prompt" });
    const body =
      reference === "stable-id"
        ? `[Stable](${target}) and [[${target}|Stable]] and [Section](${target}#heading)\n`
        : '[By path][target]\n\n[target]: branch-a/old/old.md "Keep title"\n';
    const hub = await createNode(env, { parentPath: "", name: "hub", type: "prompt" });
    await fsa.writeFile("hub/hub.md", `---\nid: ${hub}\ntype: prompt\n---\n\n${body}`);
    const before = await loadTent(fsa);
    for (const link of extractOutLinks(body)) {
      assert.equal(
        resolveOutLink(buildNodeIndex(before.byPath.values()), link, "hub/hub.md").targetNodeId,
        target,
      );
    }
    await renameNode(env, target, "new");
    const after = await loadTent(fsa);
    const rewritten = after.byId.get(hub)!.body;
    if (reference === "stable-id") assert.equal(rewritten, before.byId.get(hub)!.body);
    else assert.match(rewritten, /\[target\]: branch-a\/new\/new\.md "Keep title"/);
    for (const link of extractOutLinks(rewritten)) {
      assert.equal(
        resolveOutLink(buildNodeIndex(after.byPath.values()), link, "hub/hub.md").targetNodeId,
        target,
      );
    }
  });
}

function envFor(fsa: FsAdapter, name = "x") {
  // Distinct ids per createNode — fixed rand would collide across nodes.
  let n = 0;
  return {
    fs: fsa,
    clock: { now: () => "2026-07-18T00:00:00.000Z" },
    tentName: name,
    rand: () => {
      n += 1;
      return (n * 0.17) % 1;
    },
  };
}

test("renameNode: rejects unindexable names without moving nodes and allows nested system basenames", async () => {
  const dir = await fs.mkdtemp(path.join(testScratchRoot(), "tent-rename-reserved-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, { name: "x" });
  const env = envFor(fsa);
  const parent = await createNode(env, { parentPath: "", name: "parent", type: "prompt" });
  const child = await createNode(env, { parentPath: "parent", name: "child", type: "prompt" });
  const before = await fs.readdir(dir, { recursive: true });
  const original = await fsa.readFile("parent/parent.md");
  const childOriginal = await fsa.readFile("parent/child/child.md");
  const orderBefore = await fsa.readFile("order.json");
  for (const target of [parent, child]) {
    const names = [".gitnotes", ".github", "roles", "cards", "temp", "attachments", ".tent"];
    if (target === parent) names.push("index.md", "settings.json");
    for (const name of names)
      await assert.rejects(renameNode(env, target, name), /reserved or excluded/);
  }
  assert.deepEqual(await fs.readdir(dir, { recursive: true }), before);
  assert.equal(await fsa.readFile("parent/parent.md"), original);
  assert.equal(await fsa.readFile("parent/child/child.md"), childOriginal);
  assert.equal(await fsa.readFile("order.json"), orderBefore);
  await renameNode(env, child, "index.md");
  assert.equal((await loadTent(fsa)).byId.get(child)?.path, "parent/index.md");
});

test("rewriteNodeLinks: reference definitions preserve formatting and exclude code examples", () => {
  const body = [
    "[One][target] [Two][relative] [Three][external]",
    "",
    '[target]: <branch-a/old/old.md#heading> "Kept title"',
    "[relative]:",
    "  ../old/old.md",
    "  'Next line title'",
    "[external]: https://example.com/branch-a/old/old.md",
    "",
    "```md",
    "[example]: branch-a/old/old.md",
    "```",
    "",
    "    [indented]: branch-a/old/old.md",
    "",
  ].join("\r\n");
  const result = rewriteNodeLinks(
    body,
    "branch-a/hub/hub.md",
    new Map([
      ["branch-a/old", "branch-a/new"],
      ["branch-a/old/old", "branch-a/new/new"],
    ]),
    "old",
    "new",
  );
  assert.equal(
    result.body,
    body
      .replace("<branch-a/old/old.md#heading>", "<branch-a/new/new.md#heading>")
      .replace("../old/old.md", "../new/new.md"),
  );
  assert.equal(result.changed, true);
});

test("rewriteNodeLinks: moved source restyles outbound reference definitions", () => {
  const result = rewriteNodeLinks(
    '[Outside][ref]\n\n[ref]: ../outside/outside.md "Outside"\n',
    "old/old.md",
    new Map([
      ["old", "new"],
      ["old/old", "new/new"],
    ]),
    "old",
    "new",
    {
      renameNodeId: "node-abc123",
      conceptIndex: new Map(),
      restyleFromNotePath: "parent/new/new.md",
    },
  );
  assert.equal(result.body, '[Outside][ref]\n\n[ref]: ../../outside/outside.md "Outside"\n');
});

/** Wrap FsAdapter and fail on the Nth writeFile call (1-based). */
function injectWriteFailure(
  inner: FsAdapter,
  failOnWriteNumber: number,
): {
  fs: FsAdapter;
  writeCount: () => number;
} {
  let writes = 0;
  const fsAdapter: FsAdapter = {
    listDir: (dir) => inner.listDir(dir),
    readFile: (p) => inner.readFile(p),
    writeFile: async (p, content) => {
      if (p === NODE_MOVE_PENDING_PATH) return inner.writeFile(p, content);
      writes += 1;
      if (writes === failOnWriteNumber) {
        throw new Error(`injected write failure #${failOnWriteNumber} on ${p}`);
      }
      return inner.writeFile(p, content);
    },
    readBinary: (p) => inner.readBinary(p),
    writeBinary: (p, data) => inner.writeBinary(p, data),
    exists: (p) => inner.exists(p),
    mkdir: (p) => inner.mkdir(p),
    move: (from, to) => inner.move(from, to),
    remove: (p) => inner.remove(p),
    removeEmptyDir: (p) => inner.removeEmptyDir(p),
    withLock: inner.withLock?.bind(inner),
  };
  return { fs: fsAdapter, writeCount: () => writes };
}

test("rewriteNodeLinks: md path and untouched wiki text for rename root", () => {
  // Two concepts: unique alpha + unrelated gamma (index needed for unique name rewrite).
  const nodes = [
    {
      id: "node-alpha",
      path: "alpha",
      name: "alpha",
      type: "prompt",
      body: "",
      tags: [],
      coordination: "open",
      children: [],
      parent: undefined,
      fm: {},
      archived: false,
      invalid: false,
      locked: false,
    },
    {
      id: "node-child",
      path: "alpha/child",
      name: "child",
      type: "prompt",
      body: "",
      tags: [],
      coordination: "open",
      children: [],
      parent: undefined,
      fm: {},
      archived: false,
      invalid: false,
      locked: false,
    },
  ] as any;
  const conceptIndex = buildNodeIndex(nodes);
  const pathMap = new Map([
    ["alpha", "beta"],
    ["alpha/alpha", "beta/beta"],
    ["alpha/child", "beta/child"],
    ["alpha/child/child", "beta/child/child"],
  ]);
  const body = [
    "See [A](alpha/alpha.md) and [[alpha]] plus [[alpha/child]].",
    "Rel [C](./alpha.md).",
  ].join("\n");
  const out = rewriteNodeLinks(body, "other/other.md", pathMap, "alpha", "beta", {
    renameNodeId: "node-alpha",
    conceptIndex,
  });
  assert.equal(out.changed, true);
  assert.match(out.body, /beta\/beta\.md/);
  assert.match(out.body, /\[\[alpha\]\]/);
  assert.match(out.body, /\[\[alpha\/child\]\]/);
});

test("rewriteNodeLinks: leaves ambiguous unqualified wiki name unchanged", () => {
  const nodes = [
    {
      id: "node-a1",
      path: "branch-a/twin",
      name: "twin",
      type: "prompt",
      body: "",
      tags: [],
      coordination: "open",
      children: [],
      parent: undefined,
      fm: {},
      archived: false,
      invalid: false,
      locked: false,
    },
    {
      id: "node-a2",
      path: "branch-b/twin",
      name: "twin",
      type: "prompt",
      body: "",
      tags: [],
      coordination: "open",
      children: [],
      parent: undefined,
      fm: {},
      archived: false,
      invalid: false,
      locked: false,
    },
  ] as any;
  const conceptIndex = buildNodeIndex(nodes);
  const pathMap = new Map([
    ["branch-a/twin", "branch-a/twin-renamed"],
    ["branch-a/twin/twin", "branch-a/twin-renamed/twin-renamed"],
  ]);
  const body = "Ambiguous [[twin]] stays; path [[branch-a/twin]] moves.\n";
  const out = rewriteNodeLinks(body, "other/other.md", pathMap, "twin", "twin-renamed", {
    renameNodeId: "node-a1",
    conceptIndex,
  });
  assert.equal(out.changed, false);
  assert.match(out.body, /\[\[twin\]\]/);
  assert.doesNotMatch(out.body, /\[\[twin-renamed\]\]/);
  assert.match(out.body, /\[\[branch-a\/twin\]\]/);
});

test("renameNode: leaf keeps node-, renames folder + identity note", async () => {
  const dir = await fs.mkdtemp(path.join(testScratchRoot(), "tent-rename-leaf-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, { name: "x" });
  const env = envFor(fsa);
  const id = await createNode(env as any, { parentPath: "", name: "leaf", type: "prompt" });
  const result = await renameNode(env as any, id, "renamed-leaf");
  assert.equal(result.id, id);
  assert.equal(result.oldPath, "leaf");
  assert.equal(result.path, "renamed-leaf");
  assert.equal(await fsa.exists("leaf"), false);
  assert.equal(await fsa.exists("renamed-leaf/renamed-leaf.md"), true);
  const note = await fsa.readFile("renamed-leaf/renamed-leaf.md");
  assert.match(note, new RegExp(`id: ${id}`));
  const tent = await loadTent(fsa);
  assert.equal(tent.byId.get(id)?.path, "renamed-leaf");
  assert.equal(tent.byPath.has("leaf"), false);
});

test("renameNode: subtree preserves child relative paths and ids", async () => {
  const dir = await fs.mkdtemp(path.join(testScratchRoot(), "tent-rename-sub-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, { name: "x" });
  const env = envFor(fsa);
  const parentId = await createNode(env as any, { parentPath: "", name: "parent", type: "prompt" });
  const childId = await createNode(env as any, {
    parentPath: "parent",
    name: "child",
    type: "prompt",
  });
  const grandId = await createNode(env as any, {
    parentPath: "parent/child",
    name: "grand",
    type: "prompt",
  });

  const result = await renameNode(env as any, parentId, "parent-new");
  assert.equal(result.id, parentId);
  assert.equal(result.path, "parent-new");
  assert.equal(result.pathMap["parent/child"], "parent-new/child");
  assert.equal(result.pathMap["parent/child/grand"], "parent-new/child/grand");

  const tent = await loadTent(fsa);
  assert.equal(tent.byId.get(parentId)?.path, "parent-new");
  assert.equal(tent.byId.get(childId)?.path, "parent-new/child");
  assert.equal(tent.byId.get(grandId)?.path, "parent-new/child/grand");
  assert.equal(tent.byId.get(childId)?.name, "child");
  assert.equal(await fsa.exists("parent-new/child/child.md"), true);
  assert.equal(await fsa.exists("parent"), false);
});

test("renameNode: rewrites inbound md links; order stays id-keyed", async () => {
  const dir = await fs.mkdtemp(path.join(testScratchRoot(), "tent-rename-links-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, { name: "x" });
  const env = envFor(fsa);
  const a = await createNode(env as any, { parentPath: "", name: "alpha", type: "prompt" });
  const b = await createNode(env as any, { parentPath: "", name: "beta", type: "prompt" });
  await fsa.writeFile(
    "beta/beta.md",
    `---\nid: ${b}\ntype: prompt\n---\n\nSee [Alpha](../alpha/alpha.md) and [[alpha]].\n`,
  );
  const orderBefore = await loadOrder(fsa);
  orderBefore[ROOT_KEY] = [a, b];
  await saveOrder(fsa, orderBefore);

  const result = await renameNode(env as any, a, "alpha-renamed");
  assert.equal(result.id, a);
  const body = await fsa.readFile("beta/beta.md");
  assert.match(body, /alpha-renamed/);
  assert.doesNotMatch(body, /\balpha\/alpha\.md\b/);
  assert.match(body, /\[\[alpha\]\]/);
  const orderAfter = await loadOrder(fsa);
  assert.deepEqual(orderAfter[ROOT_KEY], [a, b]);
});

test("renameNode keeps workspace Markdown links outside .tent", async (t) => {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "tent-rename-outside-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const fsa = new NodeFs(path.join(workspace, ".tent"));
  await scaffoldTent(fsa, { name: "x" });
  const env = envFor(fsa);
  const alpha = await createNode(env, { parentPath: "", name: "Alpha", type: "prompt" });
  const beta = await createNode(env, { parentPath: "", name: "Beta", type: "prompt" });
  await fs.mkdir(path.join(workspace, "Alpha"));
  await fs.writeFile(path.join(workspace, "Alpha", "Alpha.md"), "workspace file\n");
  const body = [
    "[outside](../../Alpha/Alpha.md)",
    "[inside](../Alpha/Alpha.md)",
    "`[example](../Alpha/Alpha.md)` [[Alpha]]",
  ].join("\n");
  await fsa.writeFile("Beta/Beta.md", `---\nid: ${beta}\ntype: prompt\n---\n\n${body}\n`);

  await renameNode(env, alpha, "Gamma");
  const rewritten = await fsa.readFile("Beta/Beta.md");
  assert.match(rewritten, /\[outside\]\(\.\.\/\.\.\/Alpha\/Alpha\.md\)/);
  assert.match(rewritten, /\[inside\]\(\.\.\/Gamma\/Gamma\.md\)/);
  assert.match(rewritten, /`\[example\]\(\.\.\/Alpha\/Alpha\.md\)` \[\[Alpha\]\]/);
  assert.equal(
    await fs.readFile(path.join(workspace, "Alpha", "Alpha.md"), "utf8"),
    "workspace file\n",
  );
});

test("renameNode: duplicate display names leave unqualified wiki unchanged", async () => {
  const dir = await fs.mkdtemp(path.join(testScratchRoot(), "tent-rename-dup-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, { name: "x" });
  const env = envFor(fsa);
  const branchA = await createNode(env as any, {
    parentPath: "",
    name: "branch-a",
    type: "prompt",
  });
  const branchB = await createNode(env as any, {
    parentPath: "",
    name: "branch-b",
    type: "prompt",
  });
  void branchA;
  void branchB;
  const twinA = await createNode(env as any, {
    parentPath: "branch-a",
    name: "twin",
    type: "prompt",
  });
  const twinB = await createNode(env as any, {
    parentPath: "branch-b",
    name: "twin",
    type: "prompt",
  });
  const hub = await createNode(env as any, { parentPath: "", name: "hub", type: "prompt" });
  const hubBody = [
    "---",
    `id: ${hub}`,
    "type: prompt",
    "---",
    "",
    "Unqualified [[twin]] is ambiguous.",
    "Path [A](../branch-a/twin/twin.md) is unique.",
    `Other twin id ${twinB}.`,
    "",
  ].join("\n");
  await fsa.writeFile("hub/hub.md", hubBody);

  await renameNode(env as any, twinA, "twin-renamed");

  const after = await fsa.readFile("hub/hub.md");
  // Ambiguous bare wiki must stay.
  assert.match(after, /\[\[twin\]\]/);
  assert.doesNotMatch(after, /\[\[twin-renamed\]\]/);
  // Path link rewrites.
  assert.match(after, /branch-a\/twin-renamed/);
  assert.doesNotMatch(after, /branch-a\/twin\/twin\.md/);
  // Tree restored to unique paths; other twin untouched.
  assert.equal(await fsa.exists("branch-a/twin-renamed/twin-renamed.md"), true);
  assert.equal(await fsa.exists("branch-b/twin/twin.md"), true);
});

test("renameNode: injected write failure restores tree and every note byte-for-byte", async () => {
  const dir = await fs.mkdtemp(path.join(testScratchRoot(), "tent-rename-rollback-"));
  const base = new NodeFs(dir);
  await scaffoldTent(base, { name: "x" });
  const setupEnv = envFor(base);
  const a = await createNode(setupEnv as any, { parentPath: "", name: "alpha", type: "prompt" });
  const b = await createNode(setupEnv as any, { parentPath: "", name: "beta", type: "prompt" });
  const c = await createNode(setupEnv as any, { parentPath: "", name: "gamma", type: "prompt" });

  const betaOriginal = [
    "---",
    `id: ${b}`,
    "type: prompt",
    "---",
    "",
    "See [Alpha](../alpha/alpha.md) and [[alpha]].",
    "",
  ].join("\n");
  const gammaOriginal = [
    "---",
    `id: ${c}`,
    "type: prompt",
    "---",
    "",
    "Also [Alpha path](../alpha/alpha.md).",
    "",
  ].join("\n");
  await base.writeFile("beta/beta.md", betaOriginal);
  await base.writeFile("gamma/gamma.md", gammaOriginal);
  const alphaOriginal = await base.readFile("alpha/alpha.md");

  // Snapshot pre-rename tree state.
  const before = {
    alphaExists: await base.exists("alpha/alpha.md"),
    beta: await base.readFile("beta/beta.md"),
    gamma: await base.readFile("gamma/gamma.md"),
    alpha: alphaOriginal,
  };

  // Fail on the 2nd writeFile after move (first is typically beta or gamma rewrite).
  // Identity rename uses move, not writeFile; planned rewrites use writeFile.
  const injected = injectWriteFailure(base, 2);
  const env = envFor(injected.fs);

  await assert.rejects(() => renameNode(env as any, a, "alpha-renamed"), /injected write failure/);

  // Tree fully restored.
  assert.equal(await base.exists("alpha/alpha.md"), true);
  assert.equal(await base.exists("alpha-renamed"), false);
  assert.equal(await base.exists("alpha"), true);

  // Every touched note restored byte-for-byte.
  assert.equal(await base.readFile("alpha/alpha.md"), before.alpha);
  assert.equal(await base.readFile("beta/beta.md"), before.beta);
  assert.equal(await base.readFile("gamma/gamma.md"), before.gamma);
  assert.equal(await base.readFile("beta/beta.md"), betaOriginal);
  assert.equal(await base.readFile("gamma/gamma.md"), gammaOriginal);

  const tent = await loadTent(base);
  assert.equal(tent.byId.get(a)?.path, "alpha");
  assert.equal(tent.byId.get(a)?.name, "alpha");
  assert.ok(injected.writeCount() >= 2);
});

test("renameNode: refuses collision and accepts an ordinary Node rename", async () => {
  const dir = await fs.mkdtemp(path.join(testScratchRoot(), "tent-rename-guard-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, { name: "x" });
  const env = envFor(fsa);
  const a = await createNode(env as any, { parentPath: "", name: "one", type: "prompt" });
  await createNode(env as any, { parentPath: "", name: "two", type: "prompt" });
  await assert.rejects(() => renameNode(env as any, a, "two"), /already exists|sibling/i);

  const occupied = await createNode(env as any, { parentPath: "", name: "busy", type: "prompt" });
  const renamedBusy = await renameNode(env as any, occupied, "busy-free");
  assert.equal(renamedBusy.path, "busy-free");
  assert.equal(renamedBusy.id, occupied);

  // Stale Node FM alone must not block rename.
  const staleOnly = await createNode(env as any, { parentPath: "", name: "stale", type: "prompt" });
  await fsa.writeFile(
    "stale/stale.md",
    `---\nid: ${staleOnly}\ntype: prompt\nowner: ghost\nstatus: doing\n---\n\n# stale\n`,
  );
  const renamed = await renameNode(env as any, staleOnly, "stale-free");
  assert.equal(renamed.path, "stale-free");
});
