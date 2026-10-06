import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { createNode, renameNode, moveNode } from "../src/core/ops.js";
import { readNodeForEdit } from "../src/core/node-query.js";
import { writeNodeDocument } from "../src/core/node-document-write.js";
import { writeNodesBatch } from "../src/core/node-write-batch.js";
import {
  inspectNodeSync,
  inspectWorkspaceSync,
  linkNodeOutput,
  confirmNodeSync,
} from "../src/core/node-sync.js";
import { parseFrontmatter } from "../src/core/frontmatter.js";
import { materialLocator } from "../src/core/material.js";
import { nodeNotePath } from "../src/core/paths.js";
import { loadNodeCatalog } from "../src/core/node-catalog.js";
import { incompleteNodeReadEtag } from "../src/core/node-read-basis.js";
import { testScratchRoot } from "./scratch.js";
import { git } from "./helpers.js";
import { createHash } from "node:crypto";
import { canonicalSha256 } from "../src/core/canonical-digest.js";
import { syncMaterialIdentity } from "../src/core/node-sync-record.js";

async function fixture(t: TestContext, history = true) {
  await mkdir(testScratchRoot(), { recursive: true });
  const workspace = await mkdtemp(path.join(testScratchRoot(), "node-sync-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await scaffoldInWorkspace(new NodeFs(workspace), { name: "Sync" });
  const root = path.join(workspace, ".tent"),
    fs = new NodeFs(root);
  if (history) await git(root, "init", "--initial-branch=main");
  const env = { fs, clock: { now: () => "2026-10-05T00:00:00.000Z" }, tentName: "Sync" };
  await writeFile(path.join(workspace, "input.txt"), "input v1");
  await writeFile(path.join(workspace, "output.txt"), "output v1");
  const resource = pathToFileURL(path.join(workspace, "input.txt")).href;
  const create = (name: string, type = "prompt", parentPath = "") =>
    createNode(env, { parentPath, name, type, body: "original\n" });
  async function edit(id: string, patch: Parameters<typeof writeNodeDocument>[2]) {
    const current = await readNodeForEdit(fs, id);
    return writeNodeDocument(fs, id, { baseEtag: current.etag, ...patch });
  }
  return { workspace, root, fs, env, resource, create, edit };
}

test("link-output accepts Workspace paths, bundle addresses, Node IDs and URIs with filename defaults", async (t) => {
  const { fs, workspace, root, create } = await fixture(t);
  await create("Parent");
  const goal = await create("Goal", "goal", "Parent");
  const reference = await create("Reference");
  await mkdir(path.join(workspace, "out"));
  await writeFile(path.join(workspace, "out", "page.html"), "first");
  const linked = await linkNodeOutput(fs, goal, { resource: "out/page.html" });
  assert.equal(linked.path, "Parent/Goal/page.html");
  const saved = await readNodeForEdit(fs, linked.nodeId);
  assert.equal(saved.frontmatter.type, "output-asset");
  assert.equal(
    materialLocator(saved.frontmatter.resource as string, nodeNotePath(saved.path)).kind,
    "path",
  );
  assert.equal(
    (
      materialLocator(saved.frontmatter.resource as string, nodeNotePath(saved.path)) as {
        target: string;
      }
    ).target,
    "../out/page.html",
  );
  assert.equal((await inspectNodeSync(fs, linked.nodeId)).materials[0]!.state, "current");
  const retainedHead = await fs.history.currentCommit();
  await writeFile(path.join(workspace, "out", "page.html"), "changed");
  assert.equal((await inspectNodeSync(fs, linked.nodeId)).state, "behind");
  const freshSync = await inspectWorkspaceSync(new NodeFs(root));
  assert.equal(freshSync.nodes.find((node) => node.nodeId === linked.nodeId)!.state, "behind");
  assert.equal(await fs.history.currentCommit(), retainedHead);
  const duplicate = await linkNodeOutput(fs, goal, { resource: "./out/page.html" });
  assert.equal(duplicate.path, "Parent/Goal/page.html 2");
  const explicit = await linkNodeOutput(fs, goal, { resource: "out/page.html", name: "Selected" });
  assert.equal(explicit.path, "Parent/Goal/Selected");
  await mkdir(path.join(root, "attachments"), { recursive: true });
  await writeFile(path.join(root, "attachments", "asset.svg"), "asset");
  const bundle = await linkNodeOutput(fs, goal, { resource: "/attachments/asset.svg" });
  const bundleRaw = await readNodeForEdit(fs, bundle.nodeId);
  assert.equal(bundle.path, "Parent/Goal/asset.svg");
  assert.equal(
    (
      materialLocator(bundleRaw.frontmatter.resource as string, nodeNotePath(bundle.path)) as {
        target: string;
      }
    ).target,
    "attachments/asset.svg",
  );
  assert.ok(!(bundleRaw.frontmatter.resource as string).startsWith("/"));
  const idLinked = await linkNodeOutput(fs, goal, { resource: reference });
  assert.equal(idLinked.path, "Parent/Goal/Reference.md");
  const idRaw = await readNodeForEdit(fs, idLinked.nodeId);
  assert.equal(
    (
      materialLocator(idRaw.frontmatter.resource as string, nodeNotePath(idRaw.path)) as {
        target: string;
      }
    ).target,
    "Reference/Reference.md",
  );
  const uri = pathToFileURL(path.join(workspace, "out", "page.html")).href;
  const uriLinked = await linkNodeOutput(fs, goal, { resource: uri, name: "URI" });
  assert.equal((await readNodeForEdit(fs, uriLinked.nodeId)).frontmatter.resource, uri);
  fs.observeMaterial = async () => {
    throw new Error("Remote URI must not be observed or fetched");
  };
  const remote = "https://example.invalid/reports/report.html";
  const remoteLinked = await linkNodeOutput(fs, goal, { resource: remote });
  assert.equal(remoteLinked.path, "Parent/Goal/report.html");
  assert.equal((await readNodeForEdit(fs, remoteLinked.nodeId)).frontmatter.resource, remote);
});

test("link-output rejects missing, unreadable and directory materials before leaving Node, order or Git writes", async (t) => {
  const { fs, workspace, create } = await fixture(t);
  const goal = await create("Goal", "goal");
  await mkdir(path.join(workspace, "directory"));
  await writeFile(path.join(workspace, "unreadable.txt"), "bytes");
  const order = await fs.readFile("order.json"),
    head = await fs.history.currentCommit(),
    records = await fs.history.nodeRecords();
  const observer = fs.observeMaterial.bind(fs);
  fs.observeMaterial = async (resource, documentPath) => {
    if (resource.endsWith("unreadable.txt"))
      throw Object.assign(new Error("EACCES: unreadable material"), { code: "EACCES" });
    return observer(resource, documentPath);
  };
  for (const resource of [
    "missing.html",
    pathToFileURL(path.join(workspace, "missing.html")).href,
    "directory",
    pathToFileURL(path.join(workspace, "directory")).href,
    "unreadable.txt",
  ])
    await assert.rejects(linkNodeOutput(fs, goal, { resource }), (error: unknown) => {
      assert.ok(error instanceof Error);
      if (resource.includes("missing.html")) {
        assert.match(error.message, /Output file not found: .*Create the file first/);
        assert.doesNotMatch(error.message, /ENOENT|lstat/);
      }
      return true;
    });
  assert.deepEqual([...(await loadNodeCatalog(fs)).byId.keys()], [goal]);
  assert.equal(await fs.readFile("order.json"), order);
  assert.equal(await fs.history.currentCommit(), head);
  assert.deepEqual(await fs.history.nodeRecords(), records);
});

test("workspace inspection keeps catalog order and isolates each Node's conflict retries", async (t) => {
  const { fs, create } = await fixture(t, false);
  const changed = await create("A"),
    racing = await create("B"),
    steady = await create("C");
  const read = fs.readFile.bind(fs);
  const counts = new Map<string, number>();
  fs.readFile = async (file) => {
    const raw = await read(file);
    if (file !== "A/A.md" && file !== "B/B.md") return raw;
    const count = (counts.get(file) ?? 0) + 1;
    counts.set(file, count);
    if (file === "A/A.md" && count === 2) {
      await fs.writeFile(file, raw + "updated\n");
      return raw + "updated\n";
    }
    return file === "B/B.md" && count % 2 === 0 ? raw + "racing\n" : raw;
  };
  const result = await inspectWorkspaceSync(fs);
  assert.deepEqual(
    result.nodes.map((node) => node.nodeId),
    [changed, racing, steady],
  );
  assert.equal(result.nodes[0]!.uncertain, undefined);
  assert.equal(result.nodes[1]!.uncertain, true);
  assert.equal(result.nodes[2]!.uncertain, undefined);
  assert.equal(counts.get("A/A.md"), 4);
  assert.equal(counts.get("B/B.md"), 4);
});

test("goal and hierarchical output follow the two-stage production and confirmation cycle", async (t) => {
  const { fs, workspace, create, edit } = await fixture(t);
  const goal = await create("Goal", "goal-requirement");
  assert.equal((await inspectNodeSync(fs, goal)).state, "ahead");
  assert.ok((await inspectNodeSync(fs, goal)).aheadSince);
  const output = await linkNodeOutput(fs, goal, {
    resource: pathToFileURL(path.join(workspace, "output.txt")).href,
    name: "Deliverable",
    by: "writer/1",
  });
  // A resource-free body output also anchors its owning goal.
  const bodyOutput = await create("Analysis", "output-analysis", "Goal");
  assert.equal((await inspectNodeSync(fs, bodyOutput)).state, "synced");
  assert.equal((await inspectNodeSync(fs, goal)).state, "synced");
  await edit(goal, { body: "changed requirement\n", by: "writer/2" });
  assert.equal((await inspectNodeSync(fs, goal)).state, "ahead");
  const behind = await inspectNodeSync(fs, bodyOutput);
  assert.equal(behind.state, "behind");
  assert.equal(behind.goalId, goal);
  assert.equal(behind.materials[0]!.resource, "/Goal/Goal.md");
  await edit(bodyOutput, { body: "updated implementation\n" });
  assert.equal((await inspectNodeSync(fs, bodyOutput)).state, "behind");
  await edit(bodyOutput, { confirm: true, by: "human:cuca" });
  await edit(output.nodeId, { confirm: true });
  assert.equal((await inspectNodeSync(fs, bodyOutput)).state, "synced");
  assert.equal((await inspectNodeSync(fs, goal)).state, "synced");
  assert.equal((await inspectNodeSync(fs, bodyOutput)).trustTier, "human-reviewed");
});

test("review regression: goal addresses and body drift, metadata and line endings do not", async (t) => {
  const { fs, create, edit, resource } = await fixture(t);
  const goal = await create("Goal", "goal-requirement");
  const output = await create("Evidence", "output", "Goal");
  for (const frontmatter of [
    { tags: ["reviewed"] },
    { type: "goal-direction" },
    { description: "metadata" },
  ]) {
    await edit(goal, { frontmatter });
    assert.equal((await inspectNodeSync(fs, output)).state, "synced");
  }
  await edit(goal, { body: "original\r\n", confirm: true });
  assert.equal((await inspectNodeSync(fs, output)).state, "synced");
  await edit(goal, { body: "original!\n" });
  assert.equal((await inspectNodeSync(fs, output)).state, "behind");
  await edit(output, { confirm: true });
  await edit(goal, { frontmatter: { sources: [{ resource, description: "first" }] } });
  assert.equal((await inspectNodeSync(fs, output)).state, "behind");
  await edit(output, { confirm: true });
  await edit(goal, { frontmatter: { sources: [{ resource, description: "second" }] } });
  assert.equal((await inspectNodeSync(fs, output)).state, "synced");
  await edit(goal, { frontmatter: { sources: [] } });
  assert.equal((await inspectNodeSync(fs, output)).state, "behind");
});

test("review regression: confirming changed goal materials keeps owned outputs pending review", async (t) => {
  const { fs, env, workspace, resource, create, edit } = await fixture(t);
  const goal = await createNode(env, {
    parentPath: "",
    name: "Goal",
    type: "goal",
    sources: [{ resource }],
  });
  const output = await create("Evidence", "output", "Goal");
  await create("Transparent", "prompt", "Goal");
  const deep = await create("Deep", "output", "Goal/Transparent");
  const nested = await create("Nested", "goal", "Goal");
  const nestedOutput = await create("Nested Evidence", "output", "Goal/Nested");
  await writeFile(path.join(workspace, "input.txt"), "new requirement\n");
  assert.equal((await inspectNodeSync(fs, goal)).state, "behind");
  const beforeConfirm = await fs.history.currentCommit();
  await edit(goal, { confirm: true });
  assert.equal((await inspectNodeSync(fs, goal)).state, "ahead");
  for (const id of [output, deep]) {
    const inspected = await inspectNodeSync(fs, id);
    assert.equal(inspected.state, "behind");
    assert.deepEqual(inspected.behind?.reasons, ["Goal materials changed"]);
  }
  assert.equal((await inspectNodeSync(fs, nestedOutput)).state, "synced");
  assert.equal((await inspectNodeSync(fs, nested)).state, "synced");
  await edit(goal, { confirm: true });
  assert.equal(
    (await inspectNodeSync(fs, output)).state,
    "behind",
    "repeat confirmation does not clear output basis",
  );
  await edit(output, { confirm: true });
  assert.equal((await inspectNodeSync(fs, output)).state, "synced");
  await writeFile(path.join(workspace, "input.txt"), "second requirement\n");
  const outputRead = await readNodeForEdit(fs, output);
  const goalRead = await readNodeForEdit(fs, goal);
  await writeNodesBatch(env, {
    items: [
      { op: "update", nodeId: output, baseEtag: outputRead.etag, confirm: true },
      { op: "update", nodeId: goal, baseEtag: goalRead.etag, confirm: true },
    ],
  });
  assert.equal(
    (await inspectNodeSync(fs, output)).state,
    "synced",
    "same batch output confirmation acknowledges final goal material event independent of input order",
  );
  assert.equal((await inspectNodeSync(fs, deep)).state, "behind");
  await git(
    path.join(workspace, ".tent"),
    "-c",
    "core.autocrlf=false",
    "reset",
    "--hard",
    beforeConfirm!,
  );
  assert.equal(
    (await inspectNodeSync(fs, output)).state,
    "synced",
    "reset rolls material events and output basis back together",
  );
  assert.equal((await inspectNodeSync(fs, goal)).state, "behind");
});

test("review regression: confirming Node materials and converting LF to CRLF does not drift consumers", async (t) => {
  const { fs, env, workspace, resource, create, edit } = await fixture(t);
  const upstream = await create("Upstream", "prompt");
  const consumer = await createNode(env, {
    parentPath: "",
    name: "Consumer",
    type: "goal",
    sources: [{ resource: "/Upstream/Upstream.md" }, { resource }],
  });
  const uriConsumer = await createNode(env, {
    parentPath: "",
    name: "URI Consumer",
    type: "prompt",
    sources: [{ resource: pathToFileURL(path.join(workspace, ".tent/Upstream/Upstream.md")).href }],
  });
  await edit(upstream, { confirm: true });
  assert.equal((await inspectNodeSync(fs, consumer)).behind, undefined);
  assert.equal((await inspectNodeSync(fs, uriConsumer)).behind, undefined);
  await writeFile(path.join(workspace, "input.txt"), "first\nsecond\n");
  await edit(consumer, { confirm: true });
  await writeFile(path.join(workspace, "input.txt"), "first\r\nsecond\r\n");
  assert.equal((await inspectNodeSync(fs, consumer)).behind, undefined);
  await edit(upstream, { body: "actual material change" });
  assert.ok((await inspectNodeSync(fs, consumer)).behind);
  assert.ok((await inspectNodeSync(fs, uriConsumer)).behind);
});

test("review regression: ahead.since follows the latest transition, survives metadata and resets", async (t) => {
  const { fs, workspace, create, edit } = await fixture(t);
  const goal = await create("Goal", "goal");
  const first = (await inspectNodeSync(fs, goal)).ahead?.since;
  const output = await create("Evidence", "output", "Goal");
  assert.equal((await inspectNodeSync(fs, goal)).ahead, undefined);
  await edit(goal, { body: "new goal" });
  const head = (await fs.history.currentCommit())!;
  // Distinct commit timestamps make a creation-time regression observable without waits.
  await git(path.join(workspace, ".tent"), "read-tree", "HEAD");
  const previousDate = process.env.GIT_COMMITTER_DATE;
  process.env.GIT_COMMITTER_DATE = "2026-10-06T02:00:00Z";
  try {
    await git(
      path.join(workspace, ".tent"),
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--amend",
      "--no-edit",
      "--date=2026-10-06T02:00:00Z",
    );
  } finally {
    if (previousDate === undefined) delete process.env.GIT_COMMITTER_DATE;
    else process.env.GIT_COMMITTER_DATE = previousDate;
  }
  const expected = await fs.history.commitTime((await fs.history.currentCommit())!);
  const inspected = await inspectNodeSync(fs, goal);
  assert.equal(inspected.ahead?.since, expected);
  assert.notEqual(inspected.ahead?.since, first);
  await edit(goal, { frontmatter: { tags: ["review"] } });
  assert.equal((await inspectNodeSync(fs, goal)).ahead?.since, expected);
  await edit(output, { confirm: true });
  assert.equal((await inspectNodeSync(fs, goal)).ahead, undefined);
  await edit(goal, { body: "another goal" });
  assert.equal(
    (await inspectNodeSync(fs, goal)).ahead?.since,
    await fs.history.commitTime((await fs.history.currentCommit())!),
  );
  assert.ok(first && head);
});

test("legacy baselines use acquisition history, preserve actual drift and do not reconfirm live content", async (t) => {
  const { fs, env, workspace, resource, create, edit } = await fixture(t);
  const upstream = await create("Upstream", "prompt");
  const goal = await createNode(env, {
    parentPath: "",
    name: "Goal",
    type: "goal-requirement",
    tags: ["old"],
    resource,
    sources: [{ resource: "/Upstream/Upstream.md" }],
    body: "old requirement\n",
  });
  const output = await create("Evidence", "output", "Goal");
  const upstreamRead = await readNodeForEdit(fs, upstream);
  const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");
  const catalog = (await loadNodeCatalog(fs)).byId;
  const legacyGoalVersion = canonicalSha256({
    data: {
      type: "goal-requirement",
      tags: ["old"],
      resource: JSON.stringify(["uri", resource]),
      sources: [{ resource: `node:${upstream}` }],
    },
    body: "old requirement\n",
  });
  const legacy = {
    [goal]: {
      materials: [
        {
          identity: syncMaterialIdentity(resource, "Goal/Goal.md", catalog),
          version: hash("input v1\nnext\n"),
        },
        { identity: `node:${upstream}`, version: hash(upstreamRead.raw) },
      ],
    },
    [output]: { materials: [], goal: { nodeId: goal, version: legacyGoalVersion } },
  };
  await fs.history.captureUnlocked([], { operation: "test.legacy-basis", nodeRecords: legacy });
  const retainedHead = await fs.history.currentCommit();
  await writeFile(path.join(workspace, "input.txt"), "input v1\r\nnext\r\n");
  assert.equal((await inspectNodeSync(fs, output)).state, "synced");
  assert.equal((await inspectNodeSync(fs, goal)).state, "synced");
  assert.equal(await fs.history.currentCommit(), retainedHead);
  assert.deepEqual(
    (await fs.history.nodeRecords())[output],
    legacy[output],
    "reads reinterpret without rewriting receipts or confirmations",
  );
  await edit(upstream, { confirm: true });
  assert.equal(
    (await inspectNodeSync(fs, goal)).state,
    "synced",
    "legacy Node byte basis is reconstructed before upstream verified changes",
  );
  await edit(goal, { frontmatter: { tags: ["new metadata"] } });
  assert.equal(
    (await inspectNodeSync(fs, output)).state,
    "synced",
    "metadata cannot become a semantic change during upgrade",
  );
  await writeFile(path.join(workspace, "input.txt"), "actual new requirement\n");
  await edit(goal, { frontmatter: { tags: ["other metadata"] } });
  assert.equal(
    (await inspectNodeSync(fs, goal)).state,
    "behind",
    "ordinary save retains the reconstructed older material baseline",
  );
  await edit(goal, { body: "changed requirement\n" });
  assert.equal(
    (await inspectNodeSync(fs, output)).state,
    "behind",
    "historic output basis never uses latest live goal bytes",
  );
  await rm(path.join(workspace, "input.txt"));
  assert.equal((await inspectNodeSync(fs, goal)).materials[0]!.state, "unavailable");
  const unknown = (await fs.history.nodeRecords())[goal]!;
  const oldUnknownVersion = hash("unreconstructable old material");
  unknown.materials[0] = { identity: unknown.materials[0]!.identity, version: oldUnknownVersion };
  await fs.history.captureUnlocked([], {
    operation: "test.legacy-unknown",
    nodeRecords: { [goal]: unknown },
  });
  await edit(goal, { frontmatter: { tags: ["unavailable material stays unknown"] } });
  const preserved = (await fs.history.nodeRecords())[goal]!.materials[0]!;
  assert.equal(preserved.version, oldUnknownVersion);
  assert.equal(preserved.fingerprintVersion, undefined);
  assert.equal((await inspectNodeSync(fs, goal)).materials[0]!.state, "unavailable");
});

test("single Node sync reads only its body and the required goal or subtree output bodies", async (t) => {
  const { fs, create, edit } = await fixture(t);
  const ordinary = await create("Ordinary");
  const goal = await create("Goal", "goal");
  const nested = await create("Nested", "goal", "Goal");
  const own = await create("Own", "output", "Goal");
  await create("Nested Output", "output", "Goal/Nested");
  await create("Unrelated Child", "prompt", "Goal");
  await create("Elsewhere", "goal");
  await create("Other Output", "output", "Elsewhere");
  await edit(nested, { body: "changed nested goal" });
  const read = fs.readFile.bind(fs),
    bodies = new Set<string>();
  fs.readFile = async (file) => {
    if (file.endsWith(".md") && file.includes("/")) bodies.add(file);
    return read(file);
  };
  await inspectNodeSync(fs, ordinary);
  assert.deepEqual([...bodies], ["Ordinary/Ordinary.md"]);
  bodies.clear();
  assert.equal((await inspectNodeSync(fs, own)).state, "synced");
  assert.deepEqual([...bodies].sort(), ["Goal/Goal.md", "Goal/Own/Own.md"]);
  bodies.clear();
  assert.equal(
    (await inspectNodeSync(fs, goal)).state,
    "synced",
    "nested goal drift does not make parent-owned output drift",
  );
  assert.deepEqual([...bodies].sort(), [
    "Goal/Goal.md",
    "Goal/Nested/Nested Output/Nested Output.md",
    "Goal/Nested/Nested.md",
    "Goal/Own/Own.md",
  ]);
  fs.readFile = read;
  await edit(goal, { body: "changed parent goal" });
  assert.equal((await inspectNodeSync(fs, goal)).state, "ahead");
});

test("explicit deprecated Nodes remain inspectable while workspace inspection excludes them", async (t) => {
  const { fs, create, edit } = await fixture(t, false);
  const id = await create("Deprecated");
  await edit(id, {
    frontmatter: {
      status: "deprecated",
      verified: { by: "human:cuca", at: "2026-10-05T00:00:00Z" },
    },
  });
  const inspection = await inspectNodeSync(fs, id);
  assert.equal(inspection.nodeId, id);
  assert.equal(inspection.state, "synced");
  assert.equal(inspection.trustTier, "human-reviewed");
  const workspace = await inspectWorkspaceSync(fs);
  assert.equal(
    workspace.nodes.some((n) => n.nodeId === id),
    false,
  );
  assert.equal(workspace.counts.synced, 0);
});

test("nearest goal ownership, subtree output presence and deprecated outputs are independent", async (t) => {
  const { fs, create, edit } = await fixture(t);
  const top = await create("Direction", "goal-direction");
  const child = await create("Small", "goal", "Direction");
  const output = await create("Evidence", "output-evidence", "Direction/Small");
  assert.equal((await inspectNodeSync(fs, output)).goalId, child);
  assert.notEqual((await inspectNodeSync(fs, top)).state, "ahead");
  await edit(top, { body: "parent changes" });
  assert.equal((await inspectNodeSync(fs, output)).state, "synced");
  await edit(child, { body: "small changes" });
  assert.equal((await inspectNodeSync(fs, output)).state, "behind");
  assert.equal((await inspectNodeSync(fs, child)).state, "ahead");
  await edit(output, { frontmatter: { status: "deprecated" } });
  const inspection = await inspectWorkspaceSync(fs);
  assert.equal(inspection.outputNodes.length, 0);
  assert.ok(inspection.requirementsWithoutOutputs.includes(top));
  assert.ok(inspection.requirementsWithoutOutputs.includes(child));
});

test("a goal counts ahead and behind independently and each cause resolves separately", async (t) => {
  const { fs, env, resource, workspace, edit } = await fixture(t);
  const goal = await createNode(env, {
    parentPath: "",
    name: "Goal",
    type: "goal",
    sources: [{ resource }],
  });
  await writeFile(path.join(workspace, "input.txt"), "input v2");
  let inspected = await inspectWorkspaceSync(fs);
  let result = inspected.nodes.find((node) => node.nodeId === goal)!;
  assert.ok(result.ahead && result.behind);
  assert.deepEqual(inspected.counts, { synced: 0, ahead: 1, behind: 1, unanchored: 0 });
  assert.match(result.behind.reasons.join("; "), /Material changed/);
  assert.deepEqual(result.ahead.reasons, ["Goal subtree has no current output Node"]);
  assert.equal(result.ahead.since, result.aheadSince);
  await edit(goal, { body: "ordinary change" });
  assert.ok((await inspectNodeSync(fs, goal)).behind, "ordinary save cannot clear behind");
  const output = await linkNodeOutput(fs, goal, { resource: "output.txt" });
  result = await inspectNodeSync(fs, goal);
  assert.ok(result.behind);
  assert.equal(result.ahead, undefined, "a current output resolves only ahead");
  await edit(goal, { body: "new requirement" });
  result = await inspectNodeSync(fs, goal);
  assert.ok(result.behind && result.ahead);
  assert.deepEqual(result.ahead.reasons, ["Owned output is behind the current goal version"]);
  const read = await readNodeForEdit(fs, goal);
  await confirmNodeSync(fs, goal, { baseEtag: read.etag });
  result = await inspectNodeSync(fs, goal);
  assert.equal(result.behind, undefined);
  assert.ok(result.ahead, "confirming goal material does not confirm its output");
  await edit(output.nodeId, { confirm: true });
  result = await inspectNodeSync(fs, goal);
  assert.equal(result.behind, undefined);
  assert.equal(result.ahead, undefined);
});

test("an expired goal without Git or outputs has both flags and unknown ahead time", async (t) => {
  const { fs, create, edit } = await fixture(t, false);
  const goal = await create("Expired", "goal");
  await edit(goal, { frontmatter: { stale_after: "2020-01-01T00:00:00Z" } });
  const result = await inspectNodeSync(fs, goal);
  assert.ok(result.ahead && result.behind);
  assert.equal(result.ahead.since, undefined);
  assert.match(result.behind.reasons[0]!, /stale/);
});

test("ordinary saves retain changed and unreadable material versions; only new declarations get a baseline", async (t) => {
  const { fs, workspace, env, resource, edit } = await fixture(t);
  const id = await createNode(env, {
    parentPath: "",
    name: "Facts",
    type: "prompt",
    sources: [{ resource }],
  });
  const before = await inspectNodeSync(fs, id);
  await writeFile(path.join(workspace, "input.txt"), "input v2");
  await edit(id, { body: "unrelated" });
  const changed = await inspectNodeSync(fs, id);
  assert.equal(changed.state, "behind");
  assert.equal(changed.materials[0]!.recordedVersion, before.materials[0]!.recordedVersion);
  await writeFile(path.join(workspace, "second.txt"), "new");
  await edit(id, {
    frontmatter: {
      sources: [{ resource }, { resource: pathToFileURL(path.join(workspace, "second.txt")).href }],
    },
  });
  assert.equal((await inspectNodeSync(fs, id)).materials[1]!.state, "current");
  await rm(path.join(workspace, "input.txt"));
  await edit(id, { confirm: true });
  const missing = await inspectNodeSync(fs, id);
  assert.equal(missing.state, "behind");
  assert.equal(missing.materials[0]!.recordedVersion, before.materials[0]!.recordedVersion);
  await writeFile(path.join(workspace, "input.txt"), "input v2");
  await edit(id, { confirm: true });
  assert.equal((await inspectNodeSync(fs, id)).state, "synced");
});

test("own material behind and stale expiry outrank goal ahead; confirmation does not clear expiry", async (t) => {
  const { fs, workspace, env, resource, edit } = await fixture(t);
  const goal = await createNode(env, { parentPath: "", name: "Goal", type: "goal", resource });
  await writeFile(path.join(workspace, "input.txt"), "changed");
  assert.equal((await inspectNodeSync(fs, goal)).state, "behind");
  await edit(goal, { confirm: true, frontmatter: { stale_after: "2026-10-05T08:00:00+08:00" } });
  assert.equal((await inspectNodeSync(fs, goal, "2026-10-04T23:59:59.999Z")).state, "ahead");
  assert.equal((await inspectNodeSync(fs, goal, "2026-10-05T00:00:00Z")).state, "behind");
});

test("confirmation and structure edits do not drift goal version; moving existing output establishes its goal", async (t) => {
  const { fs, env, create, edit } = await fixture(t);
  const parent = await create("Parent", "prompt");
  const target = await create("Target", "prompt");
  const goal = await create("Goal", "goal");
  await edit(goal, { body: `[target](../Target/Target.md)\n` });
  const output = await create("Evidence", "output");
  await moveNode(env, output, goal, { mode: "inside" });
  assert.equal((await inspectNodeSync(fs, output)).state, "synced");
  await edit(goal, { confirm: true });
  await edit(goal, {
    frontmatter: {
      generated: { by: "import/1", at: "2026-10-05T01:00:00Z" },
      verified: { by: "human:cuca", at: "2026-10-05T01:00:00Z" },
    },
  });
  assert.equal((await inspectNodeSync(fs, output)).state, "synced");
  await renameNode(env, target, "Renamed");
  await renameNode(env, goal, "Renamed Goal");
  await moveNode(env, goal, parent, { mode: "inside" });
  assert.equal((await inspectNodeSync(fs, output)).state, "synced");
  await edit(goal, { frontmatter: { description: "real semantic change" } });
  assert.equal((await inspectNodeSync(fs, output)).state, "synced");
});

test("batch new output uses final goal and self material bytes, without embedded hash metadata", async (t) => {
  const { fs, env } = await fixture(t);
  const saved = await writeNodesBatch(env, {
    items: [
      { op: "create", ref: "goal", name: "Goal", type: "goal", body: "spec" },
      {
        op: "create",
        ref: "output",
        parent: "@goal",
        name: "Output",
        type: "output",
        resource: "@output",
        body: "implementation",
      },
    ],
  });
  const output = saved.results[1]!.nodeId;
  assert.equal((await inspectNodeSync(fs, output)).state, "synced");
  const raw = await readNodeForEdit(fs, output);
  for (const key of ["sync", "planned", "outputs", "sha256", "resource_sha256"])
    assert.equal(raw.frontmatter[key], undefined);
  const own = await inspectNodeSync(fs, output);
  assert.ok(own.materials.every((m) => m.state === "current"));
  await writeNodeDocument(fs, output, { baseEtag: raw.etag, body: "edited", confirm: true });
  assert.equal((await inspectNodeSync(fs, output)).state, "synced");
});

test("no Git means unknown material baselines and first intent time; verified remains an honest anchor", async (t) => {
  const { fs, create, edit, resource } = await fixture(t, false);
  const goal = await create("Goal", "goal");
  const id = await create("Fact");
  await edit(id, { frontmatter: { resource } });
  assert.equal((await inspectNodeSync(fs, id)).state, "unanchored");
  assert.equal((await inspectNodeSync(fs, goal)).aheadSince, undefined);
  await edit(id, { confirm: true });
  assert.equal((await inspectNodeSync(fs, id)).state, "synced");
});

test("confirmation requires a current full document ETag and retired APIs are rejected", async (t) => {
  const { fs, env, create } = await fixture(t);
  const id = await create("Fact");
  const current = await readNodeForEdit(fs, id);
  for (const baseEtag of ["", incompleteNodeReadEtag(current.etag), "stale"])
    await assert.rejects(confirmNodeSync(fs, id, { baseEtag }));
  assert.equal((await readNodeForEdit(fs, id)).raw, current.raw);
  for (const key of ["sync", "planned", "outputs", "sha256", "resource_sha256", "supersedes"])
    await assert.rejects(
      writeNodeDocument(fs, id, { baseEtag: current.etag, frontmatter: { [key]: true } }),
      /retired/,
    );
  await assert.rejects(
    writeNodesBatch(env, {
      items: [{ op: "create", ref: "old", name: "Old", type: "goal", planned: true }],
    } as never),
  );
});
