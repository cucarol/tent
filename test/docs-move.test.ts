import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { testScratchRoot } from "./scratch.js";
import * as path from "node:path";
import { test } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { injectWriteFailure } from "./helpers.js";
import type { FsAdapter } from "../src/core/adapter.js";
import { createNode, moveNode, placeNode } from "../src/core/ops.js";
import { loadTent } from "../src/core/tree.js";
import { loadOrder, saveOrder, ROOT_KEY } from "../src/core/order.js";
import { scaffoldTent } from "../src/core/scaffold.js";
import { buildNodeIndex } from "../src/core/okf.js";
import { rewriteNodeLinks, renameNode } from "../src/core/rename-ops.js";

function envFor(fsa: FsAdapter, name = "x") {
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

test("moveNode preserves the directory stem when title differs from its filename", async (t) => {
  const dir = await fs.mkdtemp(path.join(testScratchRoot(), "tent-move-title-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, { name: "x" });
  const env = envFor(fsa);
  const parent = await createNode(env, { parentPath: "", name: "parent", type: "goal" });
  const target = await createNode(env, { parentPath: "", name: "source", type: "prompt" });
  const raw = `---\nid: ${target}\ntype: prompt\ntitle: Design / Review\n---\nBody\n`;
  await fsa.writeFile("source/source.md", raw);
  for (const dir of ["roles"]) {
    await fsa.mkdir(dir);
    await fsa.writeFile(
      `${dir}/reference.md`,
      `---\ntype: ${dir === "roles" ? "role" : "note"}\ncustom: keep\n---\n[Source](/source/source.md)\n`,
    );
  }
  const moved = await moveNode(env, target, parent, { mode: "inside" });
  assert.equal(moved.path, "parent/source");
  assert.equal(
    await fsa.readFile("parent/source/source.md"),
    raw.replace("Design / Review", "source"),
  );
  assert.equal((await loadTent(fsa)).byId.get(target)?.name, "source");
  for (const dir of ["roles"]) {
    const reference = await fsa.readFile(`${dir}/reference.md`);
    assert.match(reference, /custom: keep/);
    assert.match(reference, /\/parent\/source\/source\.md/);
  }
  await renameNode(env, target, "source");
  assert.equal((await loadTent(fsa)).byId.get(target)?.name, "source");
  const before = await Promise.all(
    ["parent/source/source.md", "roles/reference.md"].map(
      async (path) => [path, await fsa.readFile(path)] as const,
    ),
  );
  await assert.rejects(
    () => renameNode({ ...env, fs: injectWriteFailure(fsa, 2).fs }, target, "renamed"),
    /injected write failure/,
  );
  for (const [path, raw] of before) assert.equal(await fsa.readFile(path), raw);
  assert.equal(await fsa.exists("parent/renamed"), false);
  await renameNode(env, target, "renamed");
  for (const dir of ["roles"]) {
    assert.match(await fsa.readFile(`${dir}/reference.md`), /\/parent\/renamed\/renamed\.md/);
  }
});

test("moveNode and placeNode: keep system basenames nested and preserve rejected moves", async (t) => {
  const dir = await fs.mkdtemp(path.join(testScratchRoot(), "tent-move-reserved-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, { name: "x" });
  const env = envFor(fsa);
  const parent = await createNode(env, { parentPath: "", name: "parent", type: "prompt" });
  const dest = await createNode(env, { parentPath: "", name: "dest", type: "prompt" });
  for (const name of ["index.md", "settings.json"]) {
    const child = await createNode(env, { parentPath: "parent", name, type: "prompt" });
    const childPath = `parent/${name}`;
    const original = await fsa.readFile(`${childPath}/${name}.md`);
    const orderBefore = await fsa.readFile("order.json");
    const pathsBefore = await fs.readdir(dir, { recursive: true });
    await assert.rejects(moveNode(env, child, null, { mode: "inside" }), /reserved or excluded/);
    await assert.rejects(placeNode(env, childPath, "", { mode: "inside" }), /reserved or excluded/);
    assert.deepEqual(await fs.readdir(dir, { recursive: true }), pathsBefore);
    assert.equal(await fsa.readFile(`${childPath}/${name}.md`), original);
    assert.equal(await fsa.readFile("order.json"), orderBefore);
    assert.equal((await loadTent(fsa)).byId.get(child)?.parent?.id, parent);

    await moveNode(env, child, dest, { mode: "inside" });
    assert.equal((await loadTent(fsa)).byId.get(child)?.path, `dest/${name}`);
    assert.equal(await fsa.readFile(`dest/${name}/${name}.md`), original);
    await placeNode(env, `dest/${name}`, "parent", { mode: "inside" });
    assert.equal((await loadTent(fsa)).byId.get(child)?.path, childPath);
    assert.equal(await fsa.readFile(`${childPath}/${name}.md`), original);
  }
});

test("moveNode: reparent keeps node-, moves subtree, rewrites path links", async (t) => {
  const dir = await fs.mkdtemp(path.join(testScratchRoot(), "tent-move-reparent-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, { name: "x" });
  const env = envFor(fsa);
  const parentId = await createNode(env as any, { parentPath: "", name: "parent", type: "prompt" });
  const childId = await createNode(env as any, {
    parentPath: "parent",
    name: "child",
    type: "prompt",
  });
  const destId = await createNode(env as any, { parentPath: "", name: "dest", type: "prompt" });
  const hubId = await createNode(env as any, { parentPath: "", name: "hub", type: "prompt" });
  await fsa.writeFile(
    "hub/hub.md",
    `---\nid: ${hubId}\ntype: prompt\n---\n\nSee [Child](../parent/child/child.md) and [[parent/child]].\n`,
  );

  const result = await moveNode(env as any, childId, destId, { mode: "inside" });
  assert.equal(result.id, childId);
  assert.equal(result.oldPath, "parent/child");
  assert.equal(result.path, "dest/child");
  assert.equal(result.pathMap["parent/child"], "dest/child");
  assert.ok(result.rewrittenNotes.length >= 1);

  const tent = await loadTent(fsa);
  assert.equal(tent.byId.get(childId)?.path, "dest/child");
  assert.equal(tent.byId.get(childId)?.name, "child");
  assert.equal(
    tent.byId.get(parentId)?.children.some((c) => c.id === childId),
    false,
  );
  assert.ok(tent.byId.get(destId)?.children.some((c) => c.id === childId));
  assert.equal(await fsa.exists("dest/child/child.md"), true);
  assert.equal(await fsa.exists("parent/child"), false);

  const hub = await fsa.readFile("hub/hub.md");
  assert.match(hub, /dest\/child/);
  assert.doesNotMatch(hub, /parent\/child\/child\.md/);
});

test("moveNode: depth-changing reparent restyles ./ and ../ inside moved subtree", async (t) => {
  // Reviewer probe: parent/child → dest/nest/child must not corrupt relatives.
  const dir = await fs.mkdtemp(path.join(testScratchRoot(), "tent-move-depth-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, { name: "x" });
  const env = envFor(fsa);
  await createNode(env as any, { parentPath: "", name: "parent", type: "prompt" });
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
  const peerId = await createNode(env as any, { parentPath: "", name: "peer", type: "prompt" });
  await createNode(env as any, { parentPath: "", name: "dest", type: "prompt" });
  const nestId = await createNode(env as any, {
    parentPath: "dest",
    name: "nest",
    type: "prompt",
  });
  void grandId;
  void peerId;
  void nestId;

  await fsa.writeFile(
    "parent/child/child.md",
    [
      "---",
      `id: ${childId}`,
      "type: prompt",
      "---",
      "",
      "[G](./grand/grand.md)",
      "[P](../../peer/peer.md)",
      "[Abs](parent/child/grand/grand.md)",
      "[[parent/child/grand]]",
      "",
    ].join("\n"),
  );

  const result = await moveNode(env as any, childId, nestId, { mode: "inside" });
  assert.equal(result.path, "dest/nest/child");
  assert.equal(await fsa.exists("dest/nest/child/child.md"), true);

  const body = await fsa.readFile("dest/nest/child/child.md");
  // Relative to moved descendant: still a single-step child link (not pre-move-restyled junk).
  assert.match(body, /\[G\]\(\.\/grand\/grand\.md\)/);
  assert.doesNotMatch(body, /\[G\]\(\.\.\/\.\.\/dest\/nest\/child\/grand/);
  // Relative outbound to unmoved peer: restyled for new depth.
  assert.match(body, /\[P\]\(\.\.\/\.\.\/\.\.\/peer\/peer\.md\)/);
  assert.doesNotMatch(body, /\[P\]\(\.\.\/\.\.\/peer\/peer\.md\)/);
  // Markdown paths remap; wiki text stays literal.
  assert.match(body, /\[Abs\]\(dest\/nest\/child\/grand\/grand\.md\)/);
  assert.match(body, /\[\[parent\/child\/grand\]\]/);
  assert.doesNotMatch(body, /parent\/child\/grand\/grand\.md/);
});

test("moveNode: reparent to root restyles outbound relative to unmoved peer", async (t) => {
  const dir = await fs.mkdtemp(path.join(testScratchRoot(), "tent-move-root-rel-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, { name: "x" });
  const env = envFor(fsa);
  await createNode(env as any, { parentPath: "", name: "parent", type: "prompt" });
  const childId = await createNode(env as any, {
    parentPath: "parent",
    name: "child",
    type: "prompt",
  });
  await createNode(env as any, { parentPath: "parent/child", name: "grand", type: "prompt" });
  await createNode(env as any, { parentPath: "", name: "peer", type: "prompt" });

  await fsa.writeFile(
    "parent/child/child.md",
    [
      "---",
      `id: ${childId}`,
      "type: prompt",
      "---",
      "",
      "Peer [P](../../peer/peer.md).",
      "Abs [G](parent/child/grand/grand.md).",
      "Wiki [[parent/child/grand]].",
      "",
    ].join("\n"),
  );

  await moveNode(env as any, childId, null, { mode: "inside" });
  assert.equal(await fsa.exists("child/child.md"), true);
  const body = await fsa.readFile("child/child.md");
  assert.match(body, /\[P\]\(\.\.\/peer\/peer\.md\)/);
  assert.doesNotMatch(body, /\.\.\/\.\.\/peer/);
  assert.match(body, /\[G\]\(child\/grand\/grand\.md\)/);
  assert.match(body, /\[\[parent\/child\/grand\]\]/);
});

test("moveNode restyles a moved declaration to the same workspace file", async (t) => {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "tent-move-outside-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const fsa = new NodeFs(path.join(workspace, ".tent"));
  await scaffoldTent(fsa, { name: "x" });
  const env = envFor(fsa);
  const beta = await createNode(env, { parentPath: "", name: "Beta", type: "prompt" });
  const parent = await createNode(env, { parentPath: "", name: "Parent", type: "prompt" });
  await fs.mkdir(path.join(workspace, "Alpha"));
  const targets = [
    { file: "A B#C.md", url: "A%20B%23C.md#heading" },
    { file: "report.md.md", url: "report.md.md#heading" },
    { file: "report.MD", url: "report.MD?view=raw#heading" },
    { file: "report.md.txt", url: "report.md.txt" },
    { file: undefined, url: "missing.MD" },
  ];
  for (const { file } of targets) {
    if (file) await fs.writeFile(path.join(workspace, "Alpha", file), "workspace file\n");
  }
  await fs.writeFile(path.join(workspace, "Alpha", "report.md"), "different file\n");
  const links = targets.map(({ url }, index) => `[outside-${index}](../../Alpha/${url})`);
  await fsa.writeFile(
    "Beta/Beta.md",
    `---\nid: ${beta}\ntype: prompt\n---\n\n${links.join("\n")}\n`,
  );

  await moveNode(env, beta, parent, { mode: "inside" });
  const rewritten = await fsa.readFile("Parent/Beta/Beta.md");
  for (const [index, { url }] of targets.entries()) {
    assert.ok(rewritten.includes(`[outside-${index}](../../../Alpha/${url})`), url);
  }
});

test("rewriteNodeLinks: restyleFromNotePath fixes relatives when source moves", () => {
  const pathMap = new Map([
    ["parent/child", "dest/nest/child"],
    ["parent/child/child", "dest/nest/child/child"],
    ["parent/child/grand", "dest/nest/child/grand"],
    ["parent/child/grand/grand", "dest/nest/child/grand/grand"],
  ]);
  const body = [
    "[G](./grand/grand.md)",
    "[P](../../peer/peer.md)",
    "[Abs](parent/child/grand/grand.md)",
    "[[parent/child/grand]]",
  ].join("\n");
  const out = rewriteNodeLinks(body, "parent/child/child.md", pathMap, "child", "child", {
    renameNodeId: "node-child",
    conceptIndex: buildNodeIndex([] as any),
    restyleFromNotePath: "dest/nest/child/child.md",
  });
  assert.equal(out.changed, true);
  assert.match(out.body, /\[G\]\(\.\/grand\/grand\.md\)/);
  assert.match(out.body, /\[P\]\(\.\.\/\.\.\/\.\.\/peer\/peer\.md\)/);
  assert.match(out.body, /\[Abs\]\(dest\/nest\/child\/grand\/grand\.md\)/);
  assert.match(out.body, /\[\[parent\/child\/grand\]\]/);
  // Must not restyle relatives as if still under parent/child.
  assert.doesNotMatch(out.body, /\[G\]\(\.\.\/\.\.\/dest/);
  assert.doesNotMatch(out.body, /\[P\]\(\.\.\/\.\.\/peer\/peer\.md\)/);
});

test("moveNode: same-parent reorder is order-only (no link rewrite)", async (t) => {
  const dir = await fs.mkdtemp(path.join(testScratchRoot(), "tent-move-reorder-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, { name: "x" });
  const env = envFor(fsa);
  const a = await createNode(env as any, { parentPath: "", name: "alpha", type: "prompt" });
  const b = await createNode(env as any, { parentPath: "", name: "beta", type: "prompt" });
  const c = await createNode(env as any, { parentPath: "", name: "gamma", type: "prompt" });
  await fsa.writeFile(
    "beta/beta.md",
    `---\nid: ${b}\ntype: prompt\n---\n\nSee [Alpha](../alpha/alpha.md).\n`,
  );
  const orderBefore = await loadOrder(fsa);
  orderBefore[ROOT_KEY] = [a, b, c];
  await saveOrder(fsa, orderBefore);
  const betaBefore = await fsa.readFile("beta/beta.md");

  const result = await moveNode(env as any, c, null, { mode: "before", siblingId: a });
  assert.equal(result.id, c);
  assert.equal(result.path, "gamma");
  assert.equal(result.oldPath, "gamma");
  assert.deepEqual(result.rewrittenNotes, []);
  assert.equal(result.pathMap["gamma"], "gamma");

  const orderAfter = await loadOrder(fsa);
  assert.deepEqual(orderAfter[ROOT_KEY], [c, a, b]);
  assert.equal(await fsa.readFile("beta/beta.md"), betaBefore);
  assert.equal(await fsa.exists("gamma/gamma.md"), true);
});

test("moveNode: refuses cycles but preserves local deprecated status during a move", async (t) => {
  const dir = await fs.mkdtemp(path.join(testScratchRoot(), "tent-move-guard-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, { name: "x" });
  const env = envFor(fsa);
  const parent = await createNode(env as any, { parentPath: "", name: "p", type: "prompt" });
  const child = await createNode(env as any, { parentPath: "p", name: "c", type: "prompt" });

  await assert.rejects(
    () => moveNode(env as any, parent, child, { mode: "inside" }),
    /own subtree/i,
  );

  // Deprecated is currentness, not a structure lock.
  await fsa.writeFile(
    "p/c/c.md",
    `---\nid: ${child}\ntype: prompt\nstatus: deprecated\n---\n\n# c\n`,
  );
  await moveNode(env as any, child, null, { mode: "inside" });
  assert.match(await fsa.readFile("c/c.md"), /status: deprecated/);
});

test("moveNode: injected write failure restores tree and note bytes", async (t) => {
  const dir = await fs.mkdtemp(path.join(testScratchRoot(), "tent-move-rollback-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  const base = new NodeFs(dir);
  await scaffoldTent(base, { name: "x" });
  const setupEnv = envFor(base);
  const a = await createNode(setupEnv as any, { parentPath: "", name: "alpha", type: "prompt" });
  const b = await createNode(setupEnv as any, { parentPath: "", name: "beta", type: "prompt" });
  const dest = await createNode(setupEnv as any, { parentPath: "", name: "dest", type: "prompt" });
  void dest;

  const betaOriginal = [
    "---",
    `id: ${b}`,
    "type: prompt",
    "---",
    "",
    "See [Alpha](../alpha/alpha.md).",
    "",
  ].join("\n");
  await base.writeFile("beta/beta.md", betaOriginal);
  const alphaOriginal = await base.readFile("alpha/alpha.md");

  const injected = injectWriteFailure(base, 1);
  const env = envFor(injected.fs);

  await assert.rejects(
    () => moveNode(env as any, a, dest, { mode: "inside" }),
    /injected write failure/,
  );

  assert.equal(await base.exists("alpha/alpha.md"), true);
  assert.equal(await base.exists("dest/alpha"), false);
  assert.equal(await base.readFile("alpha/alpha.md"), alphaOriginal);
  assert.equal(await base.readFile("beta/beta.md"), betaOriginal);

  const tent = await loadTent(base);
  assert.equal(tent.byId.get(a)?.path, "alpha");
});
