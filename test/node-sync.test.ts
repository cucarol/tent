import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { createNode, renameNode, moveNode, archiveNode } from "../src/core/ops.js";
import { readNodeForEdit } from "../src/core/node-query.js";
import { writeNodeDocument } from "../src/core/node-document-write.js";
import { writeNodesBatch } from "../src/core/node-write-batch.js";
import { appendNodeBody } from "../src/core/node-lightwrite.js";
import {
  inspectNodeSync,
  inspectWorkspaceSync,
  linkNodeOutput,
  confirmNodeSync,
} from "../src/core/node-sync.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { materialLocator } from "../src/core/material.js";
import { nodeNotePath } from "../src/core/paths.js";
import { loadNodeCatalog } from "../src/core/node-catalog.js";
import { incompleteNodeReadEtag } from "../src/core/node-read-basis.js";
import { testScratchRoot } from "./scratch.js";
import { git } from "./helpers.js";
import { inspectCurrentContext, makeContextBrief } from "../src/core/context-brief.js";

async function fixture(t: TestContext, history = true) {
  await mkdir(testScratchRoot(), { recursive: true });
  const workspace = await mkdtemp(path.join(testScratchRoot(), "node-sync-"));
  t.after(() => rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
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

for (const method of ["single", "batch", "whole-body"] as const) {
  test(`unreadable material ${method} confirmation preserves the prior goal basis`, async (t) => {
    const { fs, root, env, create, edit } = await fixture(t);
    const upstream = await create("Upstream");
    await edit(upstream, { body: "## Plan\n\nmaterial A\n" });
    const goal = await createNode(env, {
      name: "Goal",
      parentPath: "",
      type: "goal",
      resource: pathToFileURL(path.join(root, "Upstream/Upstream.md")).href + "#Plan",
    });
    const output = await create("Evidence", "output", "Goal");
    const sync = () => inspectNodeSync(new NodeFs(root), goal);
    const record = (await fs.history.nodeRecords())[output];
    assert.ok(record);
    await edit(upstream, { body: "## Missing\n\nmaterial A\n" });
    const current = await readNodeForEdit(fs, output);
    if (method === "single") await confirmNodeSync(fs, output, { baseEtag: current.etag });
    else if (method === "batch")
      await writeNodesBatch(env, {
        items: [{ op: "update", nodeId: output, baseEtag: current.etag, confirm: true }],
      });
    else await edit(output, { body: "reviewed complete output\n" });
    const acknowledged = new NodeFs(root);
    assert.deepEqual((await acknowledged.history.nodeRecords())[output]?.goals, record.goals);
    const stillUnavailable = await inspectNodeSync(acknowledged, output);
    assert.ok(stillUnavailable.behind);
    assert.ok(
      stillUnavailable.materials.some(
        (material) => material.goalId === goal && material.state === "unavailable",
      ),
    );
    await edit(upstream, { body: "## Plan\n\nmaterial B\n" });
    const restored = await sync();
    assert.ok(restored.ahead);
    if (method !== "single") return;
    // Explicit confirmation refreshes the restored material basis.
    await confirmNodeSync(fs, output, { baseEtag: (await readNodeForEdit(fs, output)).etag });
    assert.equal((await sync()).ahead, undefined);
    await edit(upstream, { body: "## Plan\n\nmaterial C\n" });
    assert.ok((await sync()).ahead);
    await edit(upstream, { body: "## Missing\n\nmaterial C\n" });
    await confirmNodeSync(fs, output, { baseEtag: (await readNodeForEdit(fs, output)).etag });
    await edit(upstream, { body: "## Plan\n\nmaterial B\n" });
    assert.equal((await sync()).ahead, undefined);
    await edit(upstream, { body: "## Plan\n\nmaterial C\n" });
    assert.ok((await sync()).ahead);
    await confirmNodeSync(fs, output, { baseEtag: (await readNodeForEdit(fs, output)).etag });
    const sibling = await create("Second", "output", "Goal");
    await edit(goal, { body: "independent requirement\n" });
    assert.ok((await inspectNodeSync(new NodeFs(root), goal)).ahead);
    await edit(upstream, { body: "## Missing\n\nmaterial C\n" });
    await confirmNodeSync(fs, output, { baseEtag: (await readNodeForEdit(fs, output)).etag });
    await edit(upstream, { body: "## Plan\n\nmaterial D\n" });
    await confirmNodeSync(fs, output, { baseEtag: (await readNodeForEdit(fs, output)).etag });
    await confirmNodeSync(fs, sibling, { baseEtag: (await readNodeForEdit(fs, sibling)).etag });
    assert.equal((await sync()).ahead, undefined);
    await edit(upstream, { body: "## Plan\n\nmaterial E\n" });
    assert.ok((await sync()).ahead);
  });
}

test("same receipt cannot distinguish readable A from uncaptured unavailable A", async (t) => {
  const { fs, root, env, create, edit } = await fixture(t);
  const upstream = await create("Upstream");
  await edit(upstream, { body: "## Plan\n\nmaterial A\n" });
  const goal = await createNode(env, {
    name: "Goal",
    parentPath: "",
    type: "goal",
    resource: pathToFileURL(path.join(root, "Upstream/Upstream.md")).href + "#Plan",
  });
  const output = await create("Evidence", "output", "Goal");
  const beforeHead = (await fs.history.currentCommit())!;
  const beforeRaw = await fs.readFile("Goal/Evidence/Evidence.md");
  const original = await fs.readFile("Upstream/Upstream.md");
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-07T06:00:00Z") });
  const variants = [];
  for (const unavailable of [false, true]) {
    if (unavailable) await git(root, "reset", "--hard", beforeHead);
    await fs.writeFile("Goal/Evidence/Evidence.md", beforeRaw);
    await fs.writeFile(
      "Upstream/Upstream.md",
      unavailable ? original.replace("## Plan", "## Missing") : original,
    );
    await confirmNodeSync(fs, output, { baseEtag: (await readNodeForEdit(fs, output)).etag });
    const fresh = new NodeFs(root);
    const event = (await fresh.history.changesInRange()).at(-1)!;
    const observation = await inspectNodeSync(fresh, output);
    assert.equal(!!observation.behind, unavailable);
    const raw = await fresh.readFile("Goal/Evidence/Evidence.md");
    const record = (await fresh.history.nodeRecords())[output];
    // Retain only the new B bytes; no save preimage captures the external Missing state.
    const restored = serializeFrontmatter(
      parseFrontmatter(original).data,
      "## Plan\n\nmaterial B\n",
    );
    await fs.writeFile("Upstream/Upstream.md", restored);
    await fs.history.captureUnlocked([{ path: "Upstream/Upstream.md", raw: restored }], {
      operation: "document.external-capture",
    });
    const sync = await inspectNodeSync(new NodeFs(root), goal);
    assert.ok(sync.ahead);
    variants.push({
      unavailable,
      raw,
      record,
      operation: event.operation,
      ahead: sync.ahead,
    });
  }
  assert.equal(variants[0]!.raw, variants[1]!.raw);
  assert.deepEqual(variants[0]!.record, variants[1]!.record);
  assert.equal(variants[0]!.operation, variants[1]!.operation);
  assert.deepEqual(variants[0]!.ahead, variants[1]!.ahead);
  t.diagnostic(JSON.stringify(variants));
});

for (const method of ["single", "batch"] as const) {
  test(`published ${method} output save survives ordinary index mirror failure`, async (t) => {
    const { fs, root, env, create, edit } = await fixture(t);
    const goal = await create("Goal", "goal");
    const output = await create("Evidence", "output", "Goal");
    await edit(goal, { body: "requirement B\n" });
    const before = await readNodeForEdit(fs, output);
    const beforeHead = await fs.history.currentCommit();
    const capture = fs.history.captureUnlocked.bind(fs.history);
    let injected = false;
    fs.history.captureUnlocked = async (changes, metadata) => {
      if (
        !injected &&
        metadata?.operation === (method === "single" ? "node.write" : "node.write-many")
      ) {
        injected = true;
        await writeFile(path.join(root, ".git/index.lock"), "ordinary index busy");
      }
      return capture(changes, metadata);
    };
    try {
      if (method === "single") await edit(output, { body: "reviewed evidence\n", confirm: true });
      else
        await writeNodesBatch(env, {
          items: [
            {
              op: "update",
              nodeId: output,
              baseEtag: before.etag,
              body: "reviewed evidence\n",
              confirm: true,
            },
          ],
        });
    } finally {
      await rm(path.join(root, ".git/index.lock"), { force: true });
      fs.history.captureUnlocked = capture;
    }
    assert.ok(injected);
    const fresh = new NodeFs(root);
    const head = await fresh.history.currentCommit();
    assert.notEqual(head, beforeHead);
    const saved = await readNodeForEdit(fresh, output);
    assert.equal(saved.body, "reviewed evidence\n");
    assert.equal(
      parseFrontmatter(await git(root, "show", `${head}:Goal/Evidence/Evidence.md`)).body.trim(),
      saved.body.trim(),
    );
    assert.equal((await inspectNodeSync(fresh, output)).behind, undefined);
    // A later no-op capture repairs the disposable mirror without changing HEAD.
    await fresh.history.captureUnlocked([{ path: "Goal/Evidence/Evidence.md", raw: saved.raw }], {
      operation: "node.write",
    });
    assert.equal(await fresh.history.currentCommit(), head);
    assert.equal(await git(root, "diff", "--cached", "--name-only"), "");
    await writeFile(path.join(root, "manual.txt"), "manual\n");
    await git(root, "add", "manual.txt");
    await git(root, "commit", "-m", "test: manual commit after mirror repair");
    assert.equal(
      parseFrontmatter(await git(root, "show", "HEAD:Goal/Evidence/Evidence.md")).body.trim(),
      saved.body.trim(),
    );
    const published = await fresh.history.currentCommit();
    const publishedRecord = (await fresh.history.nodeRecords())[output];
    await writeFile(path.join(root, ".git/refs/heads/main.lock"), "publication blocked");
    try {
      const input = { baseEtag: saved.etag, body: "unpublished evidence\n", confirm: true };
      await assert.rejects(
        method === "single"
          ? writeNodeDocument(fresh, output, input)
          : writeNodesBatch(
              { ...env, fs: fresh },
              { items: [{ op: "update", nodeId: output, ...input }] },
            ),
        /HEAD changed during capture/,
      );
    } finally {
      await rm(path.join(root, ".git/refs/heads/main.lock"), { force: true });
    }
    assert.equal(await fresh.history.currentCommit(), published);
    assert.equal(await fresh.readFile("Goal/Evidence/Evidence.md"), saved.raw);
    assert.deepEqual((await fresh.history.nodeRecords())[output], publishedRecord);
  });

  test(`neutral ${method} output link normalization cannot acknowledge goal drift`, async (t) => {
    const { fs, root, env, create, edit } = await fixture(t);
    const goal = await create("Goal", "goal");
    const output = await create("Evidence", "output", "Goal");
    const target = await create("Target");
    await edit(output, { body: `[target](${target})\n` });
    await edit(goal, { body: "requirement B\n" });
    const retained = (await fs.history.nodeRecords())[output];
    assert.ok(retained);
    for (const mode of ["metadata", "body", "raw", "crlf"] as const) {
      const old = await readNodeForEdit(fs, output);
      const body = `[target](${target})\n`;
      await fs.writeFile("Goal/Evidence/Evidence.md", serializeFrontmatter(old.frontmatter, body));
      const current = await readNodeForEdit(fs, output);
      const patch =
        mode === "metadata"
          ? { frontmatter: { tags: [mode] } }
          : mode === "raw"
            ? { raw: current.raw }
            : { body: mode === "crlf" ? body.replace(/\n/g, "\r\n") : body };
      assert.ok((await inspectNodeSync(fs, output)).behind);
      if (method === "single") await edit(output, patch);
      else
        await writeNodesBatch(env, {
          items: [{ op: "update", nodeId: output, baseEtag: current.etag, ...patch }],
        });
      const fresh = new NodeFs(root);
      assert.ok((await inspectNodeSync(fresh, output)).behind, mode);
      assert.deepEqual((await fresh.history.nodeRecords())[output]?.goals, retained.goals, mode);
      assert.ok(
        !(await readNodeForEdit(fresh, output)).body.includes(target),
        "canonical addresses are still saved",
      );
    }
    const current = await readNodeForEdit(fs, output);
    if (method === "single") await edit(output, { body: current.body + "reviewed\n" });
    else
      await writeNodesBatch(env, {
        items: [
          {
            op: "update",
            nodeId: output,
            baseEtag: current.etag,
            body: current.body + "reviewed\n",
          },
        ],
      });
    assert.ok((await inspectNodeSync(new NodeFs(root), output)).behind);
    await edit(goal, { body: "requirement C\n" });
    const again = await readNodeForEdit(fs, output);
    if (method === "single")
      await edit(output, { frontmatter: { tags: ["confirmed metadata"] }, confirm: true });
    else
      await writeNodesBatch(env, {
        items: [
          {
            op: "update",
            nodeId: output,
            baseEtag: again.etag,
            frontmatter: { tags: ["confirmed metadata"] },
            confirm: true,
          },
        ],
      });
    assert.equal((await inspectNodeSync(new NodeFs(root), output)).behind, undefined);
  });
}

for (const independentMismatch of [false, true]) {
  test(`missing section remains unavailable${independentMismatch ? " with an independent goal mismatch" : " until restoration"}`, async (t) => {
    const { fs, root, env, create, edit } = await fixture(t);
    const upstream = await create("Upstream");
    await edit(upstream, { body: "## Plan\n\nmaterial A\n" });
    const goal = await createNode(env, {
      name: "Goal",
      parentPath: "",
      type: "goal",
      body: "requirement A\n",
      resource: pathToFileURL(path.join(root, "Upstream/Upstream.md")).href + "#Plan",
    });
    const output = await create("Evidence", "output", "Goal");
    const sync = () => inspectNodeSync(new NodeFs(root), goal);
    assert.equal((await sync()).ahead, undefined);
    if (independentMismatch) await edit(goal, { body: "requirement B\n" });
    if (independentMismatch) assert.ok((await sync()).ahead);
    await edit(upstream, { body: "## Missing\n\nmaterial A\n" });
    assert.ok(
      (await inspectNodeSync(new NodeFs(root), output)).materials.some(
        (material) => material.state === "unavailable",
      ),
    );
    await edit(upstream, { frontmatter: { tags: ["still missing"] } });
    await edit(upstream, { body: "## Plan\n\nmaterial B\n" });
    assert.ok((await sync()).ahead);
    await confirmNodeSync(fs, output, { baseEtag: (await readNodeForEdit(fs, output)).etag });
    assert.equal((await sync()).ahead, undefined);
    await edit(upstream, { body: "## Plan\n\nmaterial C\n" });
    assert.ok((await sync()).ahead);
  });
}

for (const unreadable of ["deleted", "invalid"] as const) {
  test(`restored ${unreadable} Node material exposes current drift`, async (t) => {
    const { fs, root, env, create, edit } = await fixture(t);
    const upstream = await create("Upstream");
    const goal = await createNode(env, {
      name: "Goal",
      parentPath: "",
      type: "goal",
      resource: upstream,
    });
    const output = await create("Evidence", "output", "Goal");
    // A receipt newer than the retained document must not hide its later removal.
    await confirmNodeSync(fs, output, { baseEtag: (await readNodeForEdit(fs, output)).etag });
    const file = "Upstream/Upstream.md";
    const old = await readNodeForEdit(fs, upstream);
    const raw = unreadable === "deleted" ? null : "---\nid: [\n---\nunreadable\n";
    if (raw === null) await fs.remove(file);
    else await fs.writeFile(file, raw);
    await fs.history.captureUnlocked([{ path: file, raw }], {
      operation: "document.external-capture",
    });
    const restored = serializeFrontmatter(old.frontmatter, "material B\n");
    await fs.writeFile(file, restored);
    await fs.history.captureUnlocked([{ path: file, raw: restored }], {
      operation: "document.external-capture",
    });
    const sync = await inspectNodeSync(new NodeFs(root), goal);
    assert.ok(sync.ahead);
    await edit(upstream, { body: "material C\n" });
    assert.ok((await inspectNodeSync(new NodeFs(root), goal)).ahead);
  });
}

test("retained file URI material cannot follow a relocated Node identity", async (t) => {
  const { fs, root, env, create } = await fixture(t);
  const upstream = await create("Upstream");
  const file = "Upstream/Upstream.md";
  const raw = (await readNodeForEdit(fs, upstream)).raw;
  const goal = await createNode(env, {
    name: "Goal",
    parentPath: "",
    type: "goal",
    resource: pathToFileURL(path.join(root, file)).href,
  });
  await create("Evidence", "output", "Goal");
  // Retain an external relocation without rewriting the absolute URI declaration.
  await fs.mkdir("Moved");
  await fs.move(file, "Moved/Moved.md");
  await fs.history.captureUnlocked(
    [
      { path: file, raw: null },
      { path: "Moved/Moved.md", raw },
    ],
    { operation: "document.external-capture" },
  );
  assert.equal((await inspectNodeSync(new NodeFs(root), goal)).ahead, undefined);
  const restored = serializeFrontmatter(
    { ...parseFrontmatter(raw).data, id: "node-replacement" },
    "material B\n",
  );
  await fs.writeFile(file, restored);
  await fs.history.captureUnlocked([{ path: file, raw: restored }], {
    operation: "document.external-capture",
  });
  const sync = await inspectNodeSync(new NodeFs(root), goal);
  assert.ok(sync.ahead);
});

test("portable file URI material changes make the goal ahead", async (t) => {
  const { fs, root, env, create, edit } = await fixture(t);
  const upstream = await create("Upstream");
  const goal = await createNode(env, {
    name: "Goal",
    parentPath: "",
    type: "goal",
    resource: pathToFileURL(path.join(root, "Upstream/Upstream.md")).href,
  });
  await create("Evidence", "output", "Goal");
  assert.equal((await inspectNodeSync(new NodeFs(root), goal)).ahead, undefined);
  await edit(upstream, { body: "changed material\n" });
  const event = (await new NodeFs(root).history.changesInRange()).at(-1)!;
  assert.ok(event.changes.some((change) => change.objectId === upstream && change.after));
  assert.ok((await inspectNodeSync(new NodeFs(root), goal)).ahead);
});

test("external material mismatch remains ahead when another Node material changes", async (t) => {
  const { fs, root, env, workspace, resource, create, edit } = await fixture(t);
  const upstream = await create("Upstream");
  const goal = await createNode(env, {
    name: "Goal",
    parentPath: "",
    type: "goal",
    resource,
    sources: [{ resource: upstream }],
  });
  await create("First", "output", "Goal");
  const second = await create("Second", "output", "Goal");
  await writeFile(path.join(workspace, "input.txt"), "input v2");
  await confirmNodeSync(fs, second, { baseEtag: (await readNodeForEdit(fs, second)).etag });
  const before = await inspectNodeSync(new NodeFs(root), goal);
  assert.ok(before.ahead);
  await edit(upstream, { body: "material B\n" });
  const after = await inspectNodeSync(new NodeFs(root), goal);
  assert.ok(after.ahead);
});

test("link-output accepts Workspace paths and native Node references, and rejects internal ordinary files", async (t) => {
  const { fs, workspace, root, create } = await fixture(t);
  await create("Parent");
  const goal = await create("Goal", "goal", "Parent");
  const reference = await create("Reference");
  await mkdir(path.join(workspace, "out"));
  await writeFile(path.join(workspace, "out", "page.html"), "first");
  const linked = await linkNodeOutput(fs, goal, { resource: "out/page.html" });
  assert.equal(linked.path, "Parent/Goal/page.html");
  const saved = await readNodeForEdit(fs, linked.nodeId);
  assert.equal(saved.frontmatter.type, "output");
  assert.equal(saved.frontmatter.tags, undefined, "link-output adds no tag of its own");
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
  const explicit = await linkNodeOutput(fs, goal, {
    resource: "out/page.html",
    name: "Selected",
    tags: ["ui", "asset", "ui"],
  });
  assert.equal(explicit.path, "Parent/Goal/Selected");
  assert.deepEqual((await readNodeForEdit(fs, explicit.nodeId)).frontmatter.tags, ["asset", "ui"]);
  await assert.rejects(
    linkNodeOutput(fs, goal, { resource: "out/page.html", name: "Bad", tags: ["a/b"] }),
    /Tag name cannot contain path separators/,
  );
  assert.equal(await fs.exists("Parent/Goal/Bad"), false);
  await mkdir(path.join(root, "attachments"), { recursive: true });
  await writeFile(path.join(root, "attachments", "asset.svg"), "asset");
  const order = await fs.readFile("order.json"),
    head = await fs.history.currentCommit(),
    records = await fs.history.nodeRecords(),
    nodeIds = [...(await loadNodeCatalog(fs)).byId.keys()];
  for (const resource of [
    "/attachments/asset.svg",
    ".tent/attachments/asset.svg",
    pathToFileURL(path.join(root, "attachments", "asset.svg")).href,
  ])
    await assert.rejects(
      linkNodeOutput(fs, goal, { resource }),
      /Materials must point to Workspace files, or Node, Role, Card documents/,
    );
  assert.equal(await fs.exists("Parent/Goal/asset.svg"), false);
  assert.equal(await fs.readFile("order.json"), order);
  assert.equal(await fs.history.currentCommit(), head);
  assert.deepEqual(await fs.history.nodeRecords(), records);
  assert.deepEqual([...(await loadNodeCatalog(fs)).byId.keys()], nodeIds);
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
  const nodePathLinked = await linkNodeOutput(fs, goal, {
    resource: "/Reference/Reference.md",
    name: "Reference path",
  });
  assert.equal((await inspectNodeSync(fs, nodePathLinked.nodeId)).materials[0]!.state, "current");
  const nodeUri = pathToFileURL(path.join(root, "Reference", "Reference.md")).href;
  const nodeUriLinked = await linkNodeOutput(fs, goal, {
    resource: nodeUri,
    name: "Reference URI",
  });
  assert.equal((await readNodeForEdit(fs, nodeUriLinked.nodeId)).frontmatter.resource, nodeUri);
  assert.equal((await inspectNodeSync(fs, nodeUriLinked.nodeId)).materials[0]!.state, "current");
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

test("link-output rejects missing or unreadable files and file addresses targeting directories atomically", async (t) => {
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
  const goal = await create("Goal", "goal");
  assert.equal((await inspectNodeSync(fs, goal)).state, "ahead");
  const output = await linkNodeOutput(fs, goal, {
    resource: pathToFileURL(path.join(workspace, "output.txt")).href,
    name: "Deliverable",
    by: "writer/1",
  });
  // Any output, such as an analysis, tracks dependencies and counts for its goal.
  const bodyOutput = await create("Analysis", "output", "Goal");
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
  const goal = await create("Goal", "goal");
  const output = await create("Evidence", "output", "Goal");
  for (const frontmatter of [
    { tags: ["reviewed"] },
    { type: "goal", tags: ["reviewed", "direction"] },
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
    assert.match(
      inspected.behind?.reasons.join("; ") ?? "",
      new RegExp(`Goal ${goal}: Material changed`),
    );
    const changed = inspected.materials.find((material) => material.state === "changed")!;
    assert.equal(changed.goalId, goal);
    assert.notEqual(changed.recordedVersion, changed.currentVersion);
  }
  assert.equal((await inspectNodeSync(fs, nestedOutput)).state, "behind");
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
    "behind",
    "reset restores the output basis but cannot roll back external material bytes",
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

test("goal material mismatch survives an output-only material declaration", async (t) => {
  const { root, env, workspace, resource, create, edit } = await fixture(t);
  const goal = await createNode(env, { parentPath: "", name: "Goal", type: "goal", resource });
  const output = await create("Evidence", "output", "Goal");
  await writeFile(path.join(workspace, "input.txt"), "new material");
  await edit(goal, { confirm: true });
  const before = await inspectNodeSync(new NodeFs(root), goal);
  assert.ok(before.ahead);
  await edit(output, {
    frontmatter: { resource: pathToFileURL(path.join(workspace, "output.txt")).href },
  });
  const after = await inspectNodeSync(new NodeFs(root), goal);
  assert.ok(after.ahead);
});

test("Node and section material drift remains ahead through metadata and moves until output review", async (t) => {
  const { fs, root, env, create, edit } = await fixture(t);
  const upstream = await create("Upstream");
  const firstBody = "# Plan\nfirst\n\n# Other\nfirst\n";
  await edit(upstream, { body: firstBody });
  const whole = await createNode(env, {
    parentPath: "",
    name: "Whole",
    type: "goal",
    resource: upstream,
  });
  const section = await createNode(env, {
    parentPath: "",
    name: "Section",
    type: "goal",
    resource: pathToFileURL(path.join(root, "Upstream/Upstream.md")).href + "#Plan",
  });
  const wholeOutput = await create("Evidence", "output", "Whole");
  const sectionOutput = await create("Evidence", "output", "Section");
  const container = await create("Container");
  const sync = (id: string) => inspectNodeSync(new NodeFs(root), id);
  await edit(upstream, { frontmatter: { tags: ["metadata"] } });
  await edit(upstream, { confirm: true });
  await edit(upstream, { body: firstBody.replace(/\n/g, "\r\n") });
  await edit(upstream, { body: firstBody });
  assert.equal((await sync(whole)).ahead, undefined);
  assert.equal((await sync(section)).ahead, undefined);
  await renameNode(env, whole, "RenamedWhole");
  assert.equal((await sync(whole)).ahead, undefined, "address rewrite cannot create a transition");
  await edit(upstream, {
    body: "# Plan\nfirst\n\n# Other\nsecond\n",
  });
  assert.equal((await sync(section)).ahead, undefined, "unselected section is not material drift");
  assert.ok((await sync(whole)).ahead);
  await moveNode(env, whole, container, { mode: "inside" });
  assert.ok((await sync(whole)).ahead);
  await edit(upstream, {
    body: "# Plan\nsecond\n\n# Other\nsecond\n",
  });
  assert.ok((await sync(whole)).ahead);
  assert.ok((await sync(section)).ahead);
  await edit(whole, { confirm: true });
  await edit(section, { confirm: true });
  await edit(upstream, { confirm: true });
  assert.ok((await sync(whole)).ahead);
  assert.ok((await sync(section)).ahead);
  await edit(wholeOutput, { confirm: true });
  await edit(sectionOutput, { confirm: true });
  assert.equal((await sync(whole)).ahead, undefined);
  assert.equal((await sync(section)).ahead, undefined);
  await edit(upstream, {
    body: "# Plan\nthird\n\n# Other\nsecond\n",
  });
  assert.ok((await sync(whole)).ahead);
  assert.ok((await sync(section)).ahead);
});

test("external material changes keep the goal ahead after goal confirmation", async (t) => {
  const { fs, root, env, workspace, resource, create, edit } = await fixture(t);
  const goal = await createNode(env, { parentPath: "", name: "Goal", type: "goal", resource });
  await create("Evidence", "output", "Goal");
  await writeFile(path.join(workspace, "input.txt"), "changed externally");
  const before = await inspectNodeSync(new NodeFs(root), goal);
  assert.ok(before.ahead);
  await edit(goal, { confirm: true });
  const after = await inspectNodeSync(new NodeFs(root), goal);
  assert.ok(after.ahead);
});

test("an output can acknowledge uncaptured live Node material without borrowing older retained bytes", async (t) => {
  const { fs, root, env, create, edit } = await fixture(t);
  const upstream = await create("Upstream");
  const goal = await createNode(env, {
    parentPath: "",
    name: "Goal",
    type: "goal",
    resource: upstream,
  });
  const output = await create("Evidence", "output", "Goal");
  const upstreamPath = "Upstream/Upstream.md";
  const initial = await fs.readFile(upstreamPath);
  await fs.writeFile(upstreamPath, initial.replace("original", "uncaptured new material"));
  const before = await inspectNodeSync(new NodeFs(root), goal);
  assert.ok(before.ahead);
  await edit(output, { confirm: true });
  assert.equal((await inspectNodeSync(new NodeFs(root), goal)).ahead, undefined);
  await fs.writeFile(upstreamPath, initial.replace("original", "another uncaptured change"));
  await edit(goal, { confirm: true });
  const after = await inspectNodeSync(new NodeFs(root), goal);
  assert.ok(after.ahead);
  // Returning to an already recorded receipt still constitutes a new output review.
  await edit(output, { confirm: true });
  await edit(upstream, { body: "retained different material" });
  assert.ok((await inspectNodeSync(new NodeFs(root), goal)).ahead);
  const retainedRaw = await fs.readFile(upstreamPath);
  await fs.writeFile(upstreamPath, initial.replace("original", "another uncaptured change"));
  const current = await readNodeForEdit(fs, output);
  await confirmNodeSync(fs, output, { baseEtag: current.etag });
  assert.equal((await inspectNodeSync(new NodeFs(root), goal)).ahead, undefined);
  await fs.writeFile(
    upstreamPath,
    retainedRaw.replace("retained different material", "new uncaptured material"),
  );
  const reentered = await inspectNodeSync(new NodeFs(root), goal);
  assert.ok(reentered.ahead);
});

test("deprecated and archived goal ancestors retain the existing output dependency chain", async (t) => {
  const { fs, env, resource, workspace, create, edit } = await fixture(t);
  const outer = await createNode(env, { parentPath: "", name: "Outer", type: "goal", resource });
  const inner = await create("Inner", "goal", "Outer");
  const output = await create("Evidence", "output", "Outer/Inner");
  await writeFile(path.join(workspace, "input.txt"), "changed material");
  const before = await inspectNodeSync(fs, output);
  assert.ok(before.behind);
  await edit(outer, { frontmatter: { status: "deprecated" } });
  const deprecated = await inspectNodeSync(fs, output);
  assert.deepEqual(deprecated.goalIds, [inner, outer]);
  assert.deepEqual(deprecated.behind, before.behind);
  await edit(outer, { frontmatter: { status: "stable" } });
  await archiveNode(env, outer);
  // Archive marks the subtree; explicitly retaining a current descendant must still depend on its ancestor.
  await edit(inner, { frontmatter: { status: "stable" } });
  await edit(output, { frontmatter: { status: "stable" } });
  const archived = await inspectNodeSync(fs, output);
  assert.deepEqual(archived.goalIds, [inner, outer]);
  assert.deepEqual(archived.behind, before.behind);
  await edit(output, { confirm: true });
  assert.equal((await inspectNodeSync(fs, output)).behind, undefined);
});

test("inline and batch confirmations refresh only the explicitly confirmed output basis", async (t) => {
  for (const method of ["inline", "batch"] as const) {
    for (const confirmed of [true, false]) {
      await t.test(`${method} ${confirmed ? "confirmation" : "metadata"}`, async (subtest) => {
        const { fs, root, env, workspace, create, edit } = await fixture(subtest);
        const upstream = await create("Upstream");
        const goal = await createNode(env, {
          parentPath: "",
          name: "Goal",
          type: "goal",
          resource: upstream,
        });
        const output = await create("Evidence", "output", "Goal");
        const other = method === "batch" ? await create("Analysis", "output", "Goal") : undefined;
        const upstreamPath = "Upstream/Upstream.md";
        const original = await fs.readFile(upstreamPath);
        await edit(upstream, { body: "retained material B" });
        assert.ok((await inspectNodeSync(new NodeFs(root), goal)).ahead);
        if (confirmed) await fs.writeFile(upstreamPath, original);
        const current = await readNodeForEdit(fs, output);
        const frontmatter = {
          resource: pathToFileURL(path.join(workspace, "output.txt")).href,
          ...(!confirmed
            ? { verified: [{ by: "human:cuca", at: "2026-10-07T00:00:00.000Z" }] }
            : {}),
        };
        if (method === "inline") await edit(output, { confirm: confirmed, frontmatter });
        else
          await writeNodesBatch(env, {
            items: [
              {
                op: "update",
                nodeId: output,
                baseEtag: current.etag,
                confirm: confirmed,
                frontmatter,
              },
              {
                op: "update",
                nodeId: other!,
                baseEtag: (await readNodeForEdit(fs, other!)).etag,
                frontmatter: { tags: ["metadata"] },
              },
            ],
          });
        if (!confirmed) {
          assert.ok(
            (await inspectNodeSync(new NodeFs(root), output)).behind,
            "new own material/verified metadata does not acknowledge inherited X",
          );
          assert.ok((await inspectNodeSync(new NodeFs(root), goal)).ahead);
          return;
        }
        assert.equal((await inspectNodeSync(new NodeFs(root), goal)).ahead, undefined);
        await fs.writeFile(upstreamPath, original.replace("original", "uncaptured material C"));
        const inspected = await inspectNodeSync(new NodeFs(root), goal);
        assert.ok(inspected.ahead);
      });
    }
  }
});

test("repeat output confirmation with identical bytes and basis leaves history unchanged", async (t) => {
  const { fs, root, create, edit } = await fixture(t);
  const goal = await create("Goal", "goal");
  const output = await create("Evidence", "output", "Goal");
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-07T04:00:00Z") });
  await edit(output, { confirm: true });
  const firstHead = await fs.history.currentCommit();
  const firstRaw = (await readNodeForEdit(fs, output)).raw;
  const firstRecord = (await fs.history.nodeRecords())[output];
  await edit(output, { confirm: true });
  assert.equal(await fs.history.currentCommit(), firstHead);
  assert.equal((await readNodeForEdit(fs, output)).raw, firstRaw);
  assert.deepEqual((await fs.history.nodeRecords())[output], firstRecord);
  assert.ok(!(await git(root, "show", "-s", "--format=%B")).includes("Tent-Output-Acknowledged:"));
  assert.equal((await inspectNodeSync(new NodeFs(root), goal)).ahead, undefined);
});

test("metadata and append output writes preserve goal baselines", async (t) => {
  const { fs, root, env, create, edit } = await fixture(t);
  const upstream = await create("Upstream");
  const goal = await createNode(env, {
    parentPath: "",
    name: "Goal",
    type: "goal",
    resource: upstream,
  });
  const output = await create("Evidence", "output", "Goal");
  const initial = (await fs.history.nodeRecords())[output];
  assert.ok(initial);
  // A changed receipt proves successful observation, unlike same-basis initialization.
  await edit(upstream, { body: "baseline material B\n" });
  const retainedBaseline = (await new NodeFs(root).history.changesInRange()).at(-1)!;
  assert.ok(
    retainedBaseline.changes.some((change) => change.objectId === upstream && change.after),
  );
  await edit(output, { body: "## Plan\n\nfirst\n", confirm: true });
  const acknowledged = new NodeFs(root);
  const baseline = (await acknowledged.history.nodeRecords())[output];
  assert.ok(baseline);
  const receipt = (await acknowledged.history.changesInRange()).at(-1)!;
  assert.notEqual(
    baseline.goals![0]!.materials[0]!.version,
    initial.goals![0]!.materials[0]!.version,
  );
  assert.equal((await inspectNodeSync(acknowledged, output)).behind, undefined);
  assert.equal((await inspectNodeSync(acknowledged, goal)).ahead, undefined);
  await edit(upstream, { body: "changed material" });
  const changed = (await new NodeFs(root).history.changesInRange()).at(-1)!;
  assert.ok(changed.changes.some((change) => change.objectId === upstream && change.after));
  assert.ok((await inspectNodeSync(new NodeFs(root), goal)).ahead);
  t.diagnostic(JSON.stringify({ initial, baseline, retainedBaseline, receipt, changed }));
  const actions = [
    () => edit(output, { frontmatter: { tags: ["metadata"] } }),
    () => appendNodeBody(fs, output, { body: "append" }),
    () => appendNodeBody(fs, output, { heading: "Plan", body: "section addition" }),
  ];
  for (const action of actions) {
    await action();
    const fresh = new NodeFs(root);
    assert.deepEqual((await fresh.history.nodeRecords())[output]?.goals, baseline.goals);
    assert.ok((await inspectNodeSync(fresh, output)).behind);
    assert.ok((await inspectNodeSync(fresh, goal)).ahead);
  }
});

test("sibling outputs compare their own baselines with the same live materials", async (t) => {
  const { fs, root, env, create, edit } = await fixture(t);
  const upstream = await create("Upstream");
  const goal = await createNode(env, {
    parentPath: "",
    name: "Goal",
    type: "goal",
    resource: upstream,
  });
  const first = await create("First", "output", "Goal");
  const second = await create("Second", "output", "Goal");
  const original = await fs.readFile("Upstream/Upstream.md");
  await edit(upstream, { body: "retained material B" });
  assert.ok((await inspectNodeSync(new NodeFs(root), goal)).ahead);
  await fs.writeFile("Upstream/Upstream.md", original);
  await edit(first, { confirm: true });
  assert.equal((await inspectNodeSync(new NodeFs(root), goal)).ahead, undefined);
  await fs.writeFile("Upstream/Upstream.md", original.replace("original", "external material C"));
  const changed = await inspectNodeSync(new NodeFs(root), goal);
  assert.ok(changed.ahead);

  await fs.writeFile("Upstream/Upstream.md", original);
  await edit(first, { confirm: true });
  await edit(second, { confirm: true });
  await fs.writeFile("Upstream/Upstream.md", original.replace("original", "external material D"));
  await edit(first, { confirm: true });
  const sibling = await inspectNodeSync(new NodeFs(root), second);
  assert.ok(sibling.behind, "the confirmed observation is current material for all siblings");
  const observed = await inspectNodeSync(new NodeFs(root), goal);
  assert.ok(observed.ahead);
  await fs.writeFile("Upstream/Upstream.md", original);
  const acquiredGoal = await createNode(env, {
    parentPath: "",
    name: "Acquisition",
    type: "goal",
    resource: upstream,
  });
  await create("First", "output", "Acquisition");
  await edit(upstream, { body: "retained material E" });
  assert.ok((await inspectNodeSync(new NodeFs(root), acquiredGoal)).ahead);
  await fs.writeFile("Upstream/Upstream.md", original);
  await create("Second", "output", "Acquisition");
  assert.equal((await inspectNodeSync(new NodeFs(root), acquiredGoal)).ahead, undefined);
  await fs.writeFile("Upstream/Upstream.md", original.replace("original", "uncaptured material F"));
  assert.ok((await inspectNodeSync(new NodeFs(root), acquiredGoal)).ahead);
});

test("an output confirmation cannot treat an unreadable section's retained basis as a fresh observation", async (t) => {
  const { fs, root, env, create, edit } = await fixture(t);
  const upstream = await create("Upstream");
  await edit(upstream, { body: "## Plan\n\nmaterial A\n" });
  const goal = await createNode(env, {
    parentPath: "",
    name: "Goal",
    type: "goal",
    resource: pathToFileURL(path.join(root, "Upstream/Upstream.md")).href + "#Plan",
  });
  const output = await create("Evidence", "output", "Goal");
  const original = await fs.readFile("Upstream/Upstream.md");
  await edit(upstream, { body: "## Plan\n\nmaterial B\n" });
  const sibling = await create("Second", "output", "Goal");
  assert.ok((await inspectNodeSync(new NodeFs(root), goal)).ahead);
  const retained = await fs.readFile("Upstream/Upstream.md");
  const beforeConfirm = await fs.history.currentCommit();
  const beforeRaw = (await readNodeForEdit(fs, output)).raw;
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-07T04:00:00Z") });
  await fs.writeFile("Upstream/Upstream.md", original);
  await edit(output, { confirm: true });
  const readableRaw = (await readNodeForEdit(fs, output)).raw;
  const readableRecord = (await fs.history.nodeRecords())[output];
  const readableEvent = (await fs.history.changesInRange()).at(-1)!;
  // Only the disposable fixture repository is reset to replay the same capture's other path.
  await git(root, "reset", "--hard", beforeConfirm!);
  await fs.writeFile("Goal/Evidence/Evidence.md", beforeRaw);
  await fs.writeFile("Upstream/Upstream.md", retained.replace("## Plan", "## Missing"));
  assert.equal((await inspectNodeSync(new NodeFs(root), goal)).ahead, undefined);
  await edit(output, { confirm: true });
  const unavailableEvent = (await fs.history.changesInRange()).at(-1)!;
  assert.equal((await readNodeForEdit(fs, output)).raw, readableRaw);
  assert.deepEqual((await fs.history.nodeRecords())[output], readableRecord);
  assert.equal(unavailableEvent.operation, readableEvent.operation);
  assert.ok((await inspectNodeSync(new NodeFs(root), output)).behind);
  await fs.writeFile("Upstream/Upstream.md", original);
  assert.ok((await inspectNodeSync(new NodeFs(root), sibling)).behind);
  assert.ok((await inspectNodeSync(new NodeFs(root), goal)).ahead);
  await edit(upstream, { body: "## Plan\n\nmaterial A\n" });
  await edit(output, { confirm: true });
  await edit(sibling, { confirm: true });
  assert.equal((await inspectNodeSync(new NodeFs(root), goal)).ahead, undefined);
  await edit(upstream, { body: "## Plan\n\nmaterial C\n" });
  assert.ok((await inspectNodeSync(new NodeFs(root), goal)).ahead);
});

test("a sibling goal mismatch stays ahead through material confirmation and metadata edits", async (t) => {
  const { fs, root, env, create, edit } = await fixture(t);
  const upstream = await create("Upstream");
  const goal = await createNode(env, {
    parentPath: "",
    name: "Goal",
    type: "goal",
    resource: upstream,
  });
  const first = await create("First", "output", "Goal");
  await create("Second", "output", "Goal");
  const original = await fs.readFile("Upstream/Upstream.md");
  await edit(upstream, { body: "material B" });
  assert.ok((await inspectNodeSync(new NodeFs(root), goal)).ahead);
  await edit(goal, { body: "new requirement" });
  await fs.writeFile("Upstream/Upstream.md", original);
  await edit(first, { confirm: true });
  await edit(first, { frontmatter: { tags: ["metadata"] } });
  assert.ok((await inspectNodeSync(new NodeFs(root), goal)).ahead);
});

test("output review and acquisition use current uncaptured goal bytes", async (t) => {
  const { fs, root, workspace, create, edit } = await fixture(t);
  const goal = await create("Goal", "goal");
  const output = await create("Evidence", "output", "Goal");
  const original = await fs.readFile("Goal/Goal.md");
  await fs.writeFile("Goal/Goal.md", original.replace("original", "external goal C"));
  await edit(output, { confirm: true });
  assert.equal((await inspectNodeSync(new NodeFs(root), goal)).ahead, undefined);
  await fs.writeFile("Goal/Goal.md", original.replace("original", "external goal D"));
  const changed = await inspectNodeSync(new NodeFs(root), goal);
  assert.ok(changed.ahead);
  for (const method of ["create", "link"] as const) {
    const name = `New ${method}`;
    const otherGoal = await create(name, "goal");
    await create("First", "output", name);
    const otherRaw = await fs.readFile(`${name}/${name}.md`);
    await fs.writeFile(`${name}/${name}.md`, otherRaw.replace("original", "external goal C"));
    if (method === "create") await create("Second", "output", name);
    else
      await linkNodeOutput(fs, otherGoal, {
        resource: pathToFileURL(path.join(workspace, "output.txt")).href,
      });
    const fresh = new NodeFs(root);
    const acquired = await inspectNodeSync(fresh, otherGoal);
    assert.ok(acquired.ahead);
  }
});

test("a missing output goal basis stays unavailable after tags and rename", async (t) => {
  const { fs, root, env, create, edit } = await fixture(t);
  await create("Goal", "goal");
  const output = await create("Evidence", "output", "Goal");
  await fs.history.captureUnlocked([], {
    operation: "test.old-record",
    nodeRecords: { [output]: { v: 1, materials: [] } },
  });
  assert.ok((await inspectNodeSync(new NodeFs(root), output)).behind);
  await edit(output, { frontmatter: { tags: ["metadata"] } });
  assert.ok((await inspectNodeSync(new NodeFs(root), output)).behind);
  assert.equal((await new NodeFs(root).history.nodeRecords())[output]?.goals, undefined);
  await renameNode(env, output, "Renamed");
  assert.ok((await inspectNodeSync(new NodeFs(root), output)).behind);
  await edit(output, { confirm: true });
  assert.equal((await inspectNodeSync(new NodeFs(root), output)).behind, undefined);
});

test("goal ahead changes only with content and output review, without replaying history", async (t) => {
  const { fs, create, edit } = await fixture(t);
  const goal = await create("Goal", "goal");
  const original = await inspectNodeSync(fs, goal);
  assert.deepEqual(original.ahead, { reasons: ["Goal subtree has no current output Node"] });
  assert.equal("aheadSince" in original, false);
  const output = await create("Evidence", "output", "Goal");
  assert.equal((await inspectNodeSync(fs, goal)).ahead, undefined);
  await edit(goal, { body: "new goal" });
  t.mock.method(fs.history, "changesInRange", async () => {
    throw new Error("Sync must not replay history");
  });
  t.mock.method(fs.history, "readVersions", async () => {
    throw new Error("Sync must not read historical documents");
  });
  const inspected = await inspectNodeSync(fs, goal);
  assert.deepEqual(inspected.ahead, {
    reasons: ["An output is behind this goal's content or materials"],
  });
  await edit(goal, { frontmatter: { tags: ["review"] } });
  assert.deepEqual((await inspectNodeSync(fs, goal)).ahead, inspected.ahead);
  await edit(output, { confirm: true });
  assert.equal((await inspectNodeSync(fs, goal)).ahead, undefined);
  await edit(goal, { body: "another goal" });
  assert.deepEqual((await inspectNodeSync(fs, goal)).ahead, inspected.ahead);
});

for (const invalidParent of ["reference", "prompt-spec", "  prompt  ", "unparseable"]) {
  test(`an output below a ${invalidParent} parent cannot satisfy the live goal`, async (t) => {
    const { fs, root, create } = await fixture(t);
    const goal = await create("Goal", "goal");
    const parent = await create("Parent", "prompt", "Goal");
    await create("Evidence", "output", "Goal/Parent");
    assert.equal((await inspectNodeSync(fs, goal)).ahead, undefined);
    const filename = "Goal/Parent/Parent.md";
    const valid = await fs.readFile(filename);
    await fs.writeFile(
      filename,
      invalidParent === "unparseable"
        ? "---\nid: [\n---\ninvalid parent\n"
        : serializeFrontmatter({ id: parent, type: invalidParent }, "parent\n"),
    );
    const workspace = await inspectWorkspaceSync(new NodeFs(root));
    assert.equal(workspace.outputNodes.length, 0);
    assert.ok(workspace.requirementsWithoutOutputs.includes(goal));
    assert.deepEqual(workspace.nodes.find((node) => node.nodeId === goal)!.ahead, {
      reasons: ["Goal subtree has no current output Node"],
    });
    await fs.writeFile(filename, valid);
    assert.equal((await inspectNodeSync(new NodeFs(root), goal)).ahead, undefined);
  });
}

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

test("an issue-tagged output is enough for its goal and clears the brief's goal without outputs", async (t) => {
  const { fs, env, workspace, create } = await fixture(t);
  const goal = await create("Goal", "goal");
  const lonely = await create("Lonely", "goal");
  await create("Question", "prompt", "Lonely");
  let brief = makeContextBrief(await inspectCurrentContext(fs, workspace));
  assert.deepEqual(brief.counts, { ahead: 2, behind: 0 });
  await createNode(env, {
    parentPath: "Goal",
    name: "Known problem",
    type: "output",
    tags: ["issue"],
    body: "Fails on Windows paths.\n",
  });
  const sync = await inspectWorkspaceSync(fs);
  assert.deepEqual(sync.requirementsWithoutOutputs, [lonely]);
  assert.equal(sync.nodes.find((node) => node.nodeId === goal)!.ahead, undefined);
  assert.deepEqual(sync.nodes.find((node) => node.nodeId === lonely)!.ahead?.reasons, [
    "Goal subtree has no current output Node",
  ]);
  brief = makeContextBrief(await inspectCurrentContext(fs, workspace));
  assert.deepEqual(brief.counts, { ahead: 1, behind: 0 });
  assert.deepEqual(
    brief.ahead.map((item) => item.nodeId),
    [lonely],
  );
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

test("entire goal chain, output presence and deprecated outputs are independent", async (t) => {
  const { fs, create, edit } = await fixture(t);
  const top = await create("Direction", "goal");
  const child = await create("Small", "goal", "Direction");
  const output = await create("Evidence", "output", "Direction/Small");
  assert.equal((await inspectNodeSync(fs, output)).goalId, child);
  assert.notEqual((await inspectNodeSync(fs, top)).state, "ahead");
  await edit(top, { body: "parent changes" });
  assert.equal((await inspectNodeSync(fs, output)).state, "behind");
  assert.equal((await inspectNodeSync(fs, top)).state, "ahead");
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
  await edit(goal, { body: "ordinary change" });
  assert.ok((await inspectNodeSync(fs, goal)).behind, "ordinary save cannot clear behind");
  const output = await linkNodeOutput(fs, goal, { resource: "output.txt" });
  result = await inspectNodeSync(fs, goal);
  assert.ok(result.behind);
  assert.equal(result.ahead, undefined, "a current output resolves only ahead");
  await edit(goal, { body: "new requirement" });
  result = await inspectNodeSync(fs, goal);
  assert.ok(result.behind && result.ahead);
  assert.deepEqual(result.ahead.reasons, ["An output is behind this goal's content or materials"]);
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

test("an expired goal without Git or outputs has both attention flags", async (t) => {
  const { fs, create, edit } = await fixture(t, false);
  const goal = await create("Expired", "goal");
  await edit(goal, { frontmatter: { stale_after: "2020-01-01T00:00:00Z" } });
  const result = await inspectNodeSync(fs, goal);
  assert.ok(result.ahead && result.behind);
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

test("no Git means unknown material baselines; verified remains an honest anchor", async (t) => {
  const { fs, create, edit, resource } = await fixture(t, false);
  const goal = await create("Goal", "goal");
  const id = await create("Fact");
  await edit(id, { frontmatter: { resource } });
  assert.equal((await inspectNodeSync(fs, id)).state, "unanchored");
  assert.ok((await inspectNodeSync(fs, goal)).ahead);
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
