import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { createNode, renameNode, moveNode } from "../src/core/ops.js";
import { readNodeForEdit } from "../src/core/node-query.js";
import { writeNodeDocument, NodeWriteError } from "../src/core/node-document-write.js";
import { writeNodesBatch } from "../src/core/node-write-batch.js";
import {
  inspectNodeSync,
  inspectWorkspaceSync,
  linkNodeOutput,
  confirmNodeSync,
} from "../src/core/node-sync.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { incompleteNodeReadEtag } from "../src/core/node-read-basis.js";
import { testScratchRoot } from "./scratch.js";
import { git } from "./helpers.js";
import { runNodeCommand } from "../src/cli/node-commands.js";

async function fixture(t: TestContext) {
  const workspace = await mkdtemp(path.join(testScratchRoot(), "node-sync-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await scaffoldInWorkspace(new NodeFs(workspace), { name: "Sync" });
  const root = path.join(workspace, ".tent"),
    fs = new NodeFs(root);
  await git(root, "init", "--initial-branch=main");
  const env = { fs, clock: { now: () => "2026-10-04T01:00:00.000Z" }, tentName: "Sync" };
  await writeFile(path.join(workspace, "input.txt"), "input v1");
  await writeFile(path.join(workspace, "output.txt"), "output v1");
  const resource = pathToFileURL(path.join(workspace, "input.txt")).href;
  async function requirement() {
    return createNode(env, {
      parentPath: "",
      name: "Requirement",
      type: "goal-requirement",
      body: "Deliver this.\n",
      sources: [{ resource }],
      planned: true,
    });
  }
  async function link(id: string) {
    const before = await readNodeForEdit(fs, id);
    return linkNodeOutput(fs, id, {
      baseEtag: before.etag,
      resource: pathToFileURL(path.join(workspace, "output.txt")).href,
      provenance: "inferred",
    });
  }
  return { workspace, root, fs, env, resource, requirement, link };
}

test("requirement ahead, output synced, material change drifts, confirmation syncs", async (t) => {
  const { fs, workspace, requirement, link } = await fixture(t),
    id = await requirement();
  const ahead = await inspectNodeSync(fs, id);
  assert.equal(ahead.state, "ahead");
  assert.equal(ahead.aheadSince, "2026-10-04T01:00:00.000Z");
  assert.equal(
    ahead.materials[0]!.recordedVersion,
    createHash("sha256").update("input v1").digest("hex"),
  );
  const linked = await link(id);
  assert.equal((await inspectNodeSync(fs, id)).state, "synced");
  await writeFile(path.join(workspace, "input.txt"), "input v2");
  const behind = await inspectNodeSync(fs, id);
  assert.equal(behind.state, "behind");
  assert.equal(behind.outputs[0]!.possiblyDrifted, true);
  assert.notEqual(behind.materials[0]!.recordedVersion, behind.materials[0]!.currentVersion);
  const confirmed = await confirmNodeSync(fs, id, { baseEtag: linked.etag });
  assert.equal((await inspectNodeSync(fs, id)).state, "synced");
  const again = await confirmNodeSync(fs, id, { baseEtag: confirmed.etag });
  assert.equal(again.changed, false);
});

test("all primary goal types share requirement behavior; legacy implicit intent stays unanchored until saved", async (t) => {
  const { fs, env } = await fixture(t);
  for (const [index, type] of [
    "goal",
    "goal-direction",
    "goal-question",
    "goal-custom",
  ].entries()) {
    const id = await createNode(env, { parentPath: "", name: `Goal${index}`, type });
    assert.equal((await inspectNodeSync(fs, id)).state, "ahead");
    const saved = await readNodeForEdit(fs, id),
      parsed = parseFrontmatter(saved.raw);
    delete parsed.data.sync;
    await fs.writeFile(
      `Goal${index}/Goal${index}.md`,
      serializeFrontmatter(parsed.data, parsed.body, parsed.keyOrder),
    );
    const old = await inspectNodeSync(fs, id);
    assert.equal(old.state, "unanchored");
    assert.equal(old.aheadSince, undefined);
    const current = await readNodeForEdit(fs, id);
    if (index === 0) await confirmNodeSync(fs, id, { baseEtag: current.etag });
    else await writeNodeDocument(fs, id, { baseEtag: current.etag, body: parsed.body });
    assert.equal((await inspectNodeSync(fs, id)).state, "ahead");
    assert.ok((await inspectNodeSync(fs, id)).aheadSince);
  }
});

test("planned intent suppresses old output drift but new material changes still become behind", async (t) => {
  const { fs, workspace, requirement, link } = await fixture(t),
    id = await requirement();
  const linked = await link(id);
  const altered = await writeNodeDocument(fs, id, {
    baseEtag: linked.etag,
    body: "New implementation needed.",
  });
  assert.equal((await inspectNodeSync(fs, id)).state, "behind");
  const planned = await writeNodeDocument(fs, id, { baseEtag: altered.etag, planned: true });
  const ahead = await inspectNodeSync(fs, id);
  assert.equal(ahead.state, "ahead");
  assert.equal(ahead.outputs[0]!.possiblyDrifted, true);
  await writeFile(path.join(workspace, "input.txt"), "new user facts");
  assert.equal((await inspectNodeSync(fs, id)).state, "behind");
  await confirmNodeSync(fs, id, { baseEtag: planned.etag });
  assert.equal((await inspectNodeSync(fs, id)).state, "ahead");
});

test("resource bare paths anchor, source prose does not, and retired Nodes leave current counts", async (t) => {
  const { fs, env } = await fixture(t);
  const id = await createNode(env, {
    parentPath: "",
    name: "Bare",
    type: "prompt",
    resource: "asset.txt",
  });
  await fs.writeFile("Bare/asset.txt", "bytes");
  const current = await readNodeForEdit(fs, id);
  const saved = await writeNodeDocument(fs, id, {
    baseEtag: current.etag,
    body: "Local reference",
  });
  assert.equal((await inspectNodeSync(fs, id)).state, "synced");
  const prose = await createNode(env, {
    parentPath: "",
    name: "Prose",
    type: "prompt",
    sources: [{ resource: "User discussion" }],
  });
  assert.equal((await inspectNodeSync(fs, prose)).state, "unanchored");
  await writeNodeDocument(fs, id, { baseEtag: saved.etag, frontmatter: { status: "deprecated" } });
  const workspace = await inspectWorkspaceSync(fs);
  assert.equal(
    workspace.nodes.some((node) => node.nodeId === id),
    false,
  );
  assert.equal((await inspectNodeSync(fs, id)).state, "synced");
});

test("batch final identity references never store the changing preimage as a current baseline", async (t) => {
  const { fs, env, root } = await fixture(t);
  const target = await createNode(env, {
    parentPath: "",
    name: "Target",
    type: "prompt",
    body: "before",
  });
  const before = await readNodeForEdit(fs, target);
  const result = await writeNodesBatch(env, {
    items: [
      { op: "create", ref: "reader", name: "Reader", type: "prompt", resource: target },
      {
        op: "create",
        ref: "uriReader",
        name: "UriReader",
        type: "prompt",
        resource: pathToFileURL(path.join(root, "Target/Target.md")).href,
      },
      { op: "update", nodeId: target, baseEtag: before.etag, body: "after" },
    ],
  });
  const reader = await inspectNodeSync(fs, result.results[0]!.nodeId);
  assert.equal(reader.state, "unanchored");
  assert.equal(reader.materials[0]!.recordedVersion, undefined);
  assert.ok(reader.materials[0]!.currentVersion);
  const uriReader = await inspectNodeSync(fs, result.results[1]!.nodeId);
  assert.equal(uriReader.state, "unanchored");
  assert.equal(uriReader.materials[0]!.recordedVersion, undefined);
});

test("self references stay unanchored for local paths and file URIs", async (t) => {
  const { fs, env, root } = await fixture(t);
  for (const [index, resource] of [
    "/Self0/Self0.md",
    pathToFileURL(path.join(root, "Self1/Self1.md")).href,
  ].entries()) {
    const id = await createNode(env, {
      parentPath: "",
      name: `Self${index}`,
      type: "prompt",
      resource,
    });
    const before = await readNodeForEdit(fs, id);
    await writeNodeDocument(fs, id, { baseEtag: before.etag, body: "Self reference" });
    const inspection = await inspectNodeSync(fs, id);
    assert.equal(inspection.state, "unanchored");
    assert.equal(inspection.materials[0]!.recordedVersion, undefined);
  }
});

test("body changes cannot be erased by output metadata saves; confirmed provenance is only relationship provenance", async (t) => {
  const { fs, workspace, requirement, link } = await fixture(t),
    id = await requirement();
  const linked = await link(id);
  const changed = await writeNodeDocument(fs, id, {
    baseEtag: linked.etag,
    body: "Changed requirement.\n",
    frontmatter: { custom: { keep: "yes" } },
  });
  assert.equal((await inspectNodeSync(fs, id)).state, "behind");
  const relinked = await linkNodeOutput(fs, id, {
    baseEtag: changed.etag,
    resource: pathToFileURL(path.join(workspace, "output.txt")).href,
    provenance: "confirmed",
  });
  assert.equal((await inspectNodeSync(fs, id)).outputs[0]!.possiblyDrifted, true);
  await confirmNodeSync(fs, id, { baseEtag: relinked.etag });
  assert.equal((await inspectNodeSync(fs, id)).state, "synced");
  assert.deepEqual(parseFrontmatter((await readNodeForEdit(fs, id)).raw).data.custom, {
    keep: "yes",
  });
});

test("conversation decisions are unanchored, explicit planned intent is ahead, old Nodes gain versions only on save", async (t) => {
  const { fs, env, resource } = await fixture(t);
  const decision = await createNode(env, {
    parentPath: "",
    name: "Decision",
    type: "prompt-decision",
    body: "Agreed in conversation.",
  });
  assert.equal((await inspectNodeSync(fs, decision)).state, "unanchored");
  const marked = await writeNodeDocument(fs, decision, {
    baseEtag: (await readNodeForEdit(fs, decision)).etag,
    planned: true,
  });
  assert.equal((await inspectNodeSync(fs, decision)).state, "ahead");
  const since = (await inspectNodeSync(fs, decision)).aheadSince;
  await writeNodeDocument(fs, decision, { baseEtag: marked.etag, planned: true });
  assert.equal((await inspectNodeSync(fs, decision)).aheadSince, since);
  const legacy = await createNode(env, {
    parentPath: "",
    name: "Legacy",
    type: "prompt-reference",
    resource,
  });
  const original = await readNodeForEdit(fs, legacy),
    parsed = parseFrontmatter(original.raw);
  delete parsed.data.sync;
  await fs.writeFile(
    "Legacy/Legacy.md",
    serializeFrontmatter(parsed.data, parsed.body, parsed.keyOrder),
  );
  assert.equal((await inspectNodeSync(fs, legacy)).state, "unanchored");
  const current = await readNodeForEdit(fs, legacy);
  const saved = await writeNodeDocument(fs, legacy, { baseEtag: current.etag, body: parsed.body });
  assert.equal((await inspectNodeSync(fs, legacy)).state, "synced");
  const beforeCommit = await fs.history.currentCommit();
  const unchanged = await writeNodeDocument(fs, legacy, {
    baseEtag: saved.etag,
    body: parsed.body,
  });
  assert.equal(unchanged.changed, false);
  assert.equal(await fs.history.currentCommit(), beforeCommit);
});

test("missing and remote addresses never block normal saves or fabricate versions", async (t) => {
  const { fs, env, workspace } = await fixture(t);
  const id = await createNode(env, {
    parentPath: "",
    name: "Missing",
    type: "prompt",
    sources: [{ resource: "./absent.bin" }, { resource: "https://example.invalid/file" }],
  });
  const inspection = await inspectNodeSync(fs, id);
  assert.equal(inspection.state, "unanchored");
  assert.ok(inspection.materials.every((m) => !m.recordedVersion));
  assert.match(inspection.materials[1]!.reason!, /Remote/);
  const known = await createNode(env, {
    parentPath: "",
    name: "Known",
    type: "prompt",
    resource: pathToFileURL(path.join(workspace, "input.txt")).href,
  });
  await rm(path.join(workspace, "input.txt"));
  const old = await readNodeForEdit(fs, known);
  await writeNodeDocument(fs, known, { baseEtag: old.etag, body: parseFrontmatter(old.raw).body });
  assert.equal((await inspectNodeSync(fs, known)).state, "behind");
});

test("ordinary confirmation retains no-output requirement ahead; implemented requires observed local evidence", async (t) => {
  const { fs, env, workspace, requirement } = await fixture(t),
    id = await requirement();
  const initial = await readNodeForEdit(fs, id);
  const ordinary = await confirmNodeSync(fs, id, { baseEtag: initial.etag });
  assert.equal((await inspectNodeSync(fs, id)).state, "ahead");
  const implemented = await confirmNodeSync(fs, id, { baseEtag: ordinary.etag, implemented: true });
  assert.equal((await inspectNodeSync(fs, id)).state, "synced");
  await writeNodeDocument(fs, id, { baseEtag: implemented.etag, body: "New scope." });
  assert.equal((await inspectNodeSync(fs, id)).state, "behind");
  const saved = await writeNodeDocument(fs, id, {
    baseEtag: (await readNodeForEdit(fs, id)).etag,
    body: "Reviewed new scope.",
    confirm: true,
  });
  assert.equal((await inspectNodeSync(fs, id)).state, "synced");
  await rm(path.join(workspace, "input.txt"));
  await assert.rejects(
    confirmNodeSync(fs, id, { baseEtag: saved.etag, implemented: true }),
    /observed local material/,
  );
  const unanchored = await createNode(env, {
    parentPath: "",
    name: "Unknown",
    type: "goal-requirement",
  });
  await assert.rejects(
    confirmNodeSync(fs, unanchored, {
      baseEtag: (await readNodeForEdit(fs, unanchored)).etag,
      implemented: true,
    }),
    /observed local material/,
  );
});

test("full live CAS is mandatory and general writes protect system fields", async (t) => {
  const { fs, requirement, link } = await fixture(t),
    id = await requirement(),
    before = await readNodeForEdit(fs, id);
  await link(id);
  await assert.rejects(
    confirmNodeSync(fs, id, { baseEtag: before.etag }),
    (e) => e instanceof NodeWriteError && e.code === "ETAG_CONFLICT",
  );
  const current = await readNodeForEdit(fs, id);
  await assert.rejects(
    confirmNodeSync(fs, id, { baseEtag: incompleteNodeReadEtag(current.etag) }),
    (e) => e instanceof NodeWriteError && e.code === "INCOMPLETE_READ",
  );
  await assert.rejects(
    writeNodeDocument(fs, id, { baseEtag: current.etag, frontmatter: { outputs: [] } }),
    /system outputs/,
  );
  await assert.rejects(
    linkNodeOutput(fs, id, {
      baseEtag: current.etag,
      resource: "C:\\unsafe",
      provenance: "inferred",
    }),
    /filesystem|separator|scheme/i,
  );
  const originalObserve = fs.observeMaterial.bind(fs);
  let raced = false;
  fs.observeMaterial = async (...args) => {
    if (!raced) {
      raced = true;
      await fs.writeFile("Requirement/Requirement.md", current.raw + "external edit");
    }
    return originalObserve(...args);
  };
  await assert.rejects(
    confirmNodeSync(fs, id, { baseEtag: current.etag }),
    /changed during sync mutation/,
  );
});

test("batch observes materials in Core and rolls system metadata back with all identity bytes", async (t) => {
  const { fs, env, resource, root } = await fixture(t);
  const first = await createNode(env, { parentPath: "", name: "First", type: "prompt", resource });
  const second = await createNode(env, { parentPath: "", name: "Second", type: "prompt" });
  const a = await readNodeForEdit(fs, first),
    b = await readNodeForEdit(fs, second),
    write = fs.writeFile.bind(fs);
  fs.writeFile = async (filename, raw) => {
    if (filename === "Second/Second.md" && raw.includes("batch edit"))
      throw new Error("injected failure");
    return write(filename, raw);
  };
  await assert.rejects(
    writeNodesBatch(env, {
      items: [
        { op: "update", nodeId: first, baseEtag: a.etag, body: "batch edit", planned: true },
        { op: "update", nodeId: second, baseEtag: b.etag, body: "batch edit" },
      ],
    }),
    /injected failure/,
  );
  assert.equal(await readFile(path.join(root, "First/First.md"), "utf8"), a.raw);
  assert.equal(await readFile(path.join(root, "Second/Second.md"), "utf8"), b.raw);
  fs.writeFile = write;
  const batch = await writeNodesBatch(env, {
    items: [
      {
        op: "create",
        ref: "new",
        name: "New",
        type: "prompt",
        sources: [{ resource }],
        planned: true,
      },
    ],
  });
  assert.equal(
    (await inspectNodeSync(fs, batch.results[0]!.nodeId)).materials[0]!.state,
    "current",
  );
  assert.equal((await inspectNodeSync(fs, batch.results[0]!.nodeId)).aheadSince, env.clock.now());
});

test("output associations and material baselines follow renamed and moved declaring Nodes", async (t) => {
  const { fs, env } = await fixture(t);
  const output = await createNode(env, {
    parentPath: "",
    name: "Artifact",
    type: "output",
    body: "artifact",
  });
  const requirement = await createNode(env, {
    parentPath: "",
    name: "Need",
    type: "goal-requirement",
    sources: [{ resource: "/Artifact/Artifact.md" }],
  });
  await linkNodeOutput(fs, requirement, {
    baseEtag: (await readNodeForEdit(fs, requirement)).etag,
    resource: output,
    provenance: "recorded",
  });
  assert.equal((await inspectWorkspaceSync(fs)).unlinkedOutputs.length, 0);
  await renameNode(env, output, "Renamed");
  let current = await inspectNodeSync(fs, requirement);
  assert.equal(current.outputs[0]!.resource, "../Renamed/Renamed.md");
  assert.equal(current.materials[0]!.resource, "/Renamed/Renamed.md");
  assert.equal(current.state, "synced");
  const parent = await createNode(env, { parentPath: "", name: "Parent", type: "prompt" });
  await moveNode(env, requirement, parent, { mode: "inside" });
  current = await inspectNodeSync(fs, requirement);
  assert.equal(current.outputs[0]!.resource, "../../Renamed/Renamed.md");
  assert.equal(current.state, "synced");
});

for (const batch of [false, true]) {
  test(`${batch ? "batch" : "single"} saves preserve changed material baselines; confirm saves refresh final content and output bases`, async (t) => {
    const { fs, env, workspace, resource, requirement, link } = await fixture(t);
    await writeFile(path.join(workspace, "input.txt"), "100");
    const goal = await requirement();
    await link(goal);
    const ids = [goal];
    for (const type of ["prompt", "output"])
      ids.push(await createNode(env, { parentPath: "", name: type, type, resource }));
    const baseline = createHash("sha256").update("100").digest("hex");
    await writeFile(path.join(workspace, "input.txt"), "60");
    async function save(confirm = false) {
      const edits = await Promise.all(
        ids.map(async (nodeId) => ({
          op: "update" as const,
          nodeId,
          baseEtag: (await readNodeForEdit(fs, nodeId)).etag,
          body: confirm ? "Reviewed 60." : "Unrelated wording.",
          confirm,
        })),
      );
      if (batch) await writeNodesBatch(env, { items: edits });
      else for (const edit of edits) await writeNodeDocument(fs, edit.nodeId, edit);
    }
    await save();
    await save();
    for (const id of ids) {
      const state = await inspectNodeSync(fs, id);
      assert.equal(state.state, "behind");
      assert.equal(state.materials[0]!.recordedVersion, baseline);
    }
    await save(true);
    for (const id of ids) {
      const state = await inspectNodeSync(fs, id);
      assert.equal(state.state, "synced");
      assert.equal(state.materials[0]!.recordedVersion, state.materials[0]!.currentVersion);
      assert.match(state.materials[0]!.recordedVersion!, /^[a-f0-9]{64}$/);
    }
    assert.equal((await inspectNodeSync(fs, goal)).outputs[0]!.possiblyDrifted, false);
    await rm(path.join(workspace, "input.txt"));
    await save();
    await save(true);
    for (const id of ids) assert.equal((await inspectNodeSync(fs, id)).state, "behind");
  });

  test(`${batch ? "batch" : "single"} new declarations snapshot while repeated declarations retain recorded versions`, async (t) => {
    const { fs, env, workspace, resource } = await fixture(t);
    const id = await createNode(env, {
      parentPath: "",
      name: "Sources",
      type: "prompt",
      sources: [{ resource }, { resource, note: "again" }],
    });
    const original = (await inspectNodeSync(fs, id)).materials[0]!.recordedVersion;
    await writeFile(path.join(workspace, "input.txt"), "changed");
    const additional = pathToFileURL(path.join(workspace, "output.txt")).href;
    const edit = {
      op: "update" as const,
      nodeId: id,
      baseEtag: (await readNodeForEdit(fs, id)).etag,
      frontmatter: {
        sources: [{ resource }, { resource, note: "again" }, { resource: additional }],
      },
    };
    if (batch) await writeNodesBatch(env, { items: [edit] });
    else await writeNodeDocument(fs, id, edit);
    const current = await inspectNodeSync(fs, id);
    assert.equal(current.state, "behind");
    assert.deepEqual(
      current.materials.slice(0, 2).map((m) => m.recordedVersion),
      [original, original],
    );
    assert.equal(current.materials[2]!.state, "current");
  });
}

test("planned save cannot acknowledge changed material; explicit confirmation can", async (t) => {
  const { fs, workspace, requirement, link } = await fixture(t);
  const id = await requirement();
  const linked = await link(id);
  await writeFile(path.join(workspace, "input.txt"), "60");
  const planned = await writeNodeDocument(fs, id, { baseEtag: linked.etag, planned: true });
  assert.equal((await inspectNodeSync(fs, id)).state, "behind");
  await writeNodeDocument(fs, id, { baseEtag: planned.etag, planned: true, confirm: true });
  assert.equal((await inspectNodeSync(fs, id)).state, "ahead");
});

test("confirmation with save requires an exact complete live ETag in Core, batch and CLI", async (t) => {
  const { fs, env, workspace, resource } = await fixture(t);
  const id = await createNode(env, { parentPath: "", name: "Review", type: "prompt", resource });
  const original = await readNodeForEdit(fs, id);
  const current = await writeNodeDocument(fs, id, { baseEtag: original.etag, body: "edit" });
  for (const baseEtag of [
    original.etag,
    `W/"${current.etag}"`,
    `${current.etag}invalid`,
    incompleteNodeReadEtag(current.etag),
  ]) {
    await assert.rejects(
      writeNodeDocument(fs, id, { baseEtag, confirm: true }),
      (error) =>
        error instanceof NodeWriteError &&
        ["ETAG_CONFLICT", "INCOMPLETE_READ"].includes(error.code),
    );
    await assert.rejects(
      writeNodesBatch(env, { items: [{ op: "update", nodeId: id, baseEtag, confirm: true }] }),
      (error) =>
        error instanceof NodeWriteError &&
        ["ETAG_CONFLICT", "INCOMPLETE_READ"].includes(error.code),
    );
  }
  await writeFile(path.join(workspace, "input.txt"), "60");
  const incomplete = await runNodeCommand(
    "write",
    [id, "--confirm", "--base-etag", incompleteNodeReadEtag(current.etag)],
    { workspace, json: true },
  );
  assert.equal(incomplete.exitCode, 1);
  const saved = await runNodeCommand(
    "write",
    [id, "--body", "Reviewed.", "--confirm", "--base-etag", current.etag],
    { workspace, json: true },
  );
  assert.equal(saved.exitCode, 0, saved.stderr);
  assert.equal((await inspectNodeSync(fs, id)).state, "synced");
});

test("confirmed implementation and output linking remove planned rather than persisting false", async (t) => {
  const { fs, env, resource, requirement, link } = await fixture(t);
  const linked = await requirement();
  await link(linked);
  assert.equal("planned" in (await readNodeForEdit(fs, linked)).frontmatter, false);
  const other = await createNode(env, {
    parentPath: "",
    name: "Implemented",
    type: "goal-direction",
    resource,
    planned: true,
  });
  const confirmed = await confirmNodeSync(fs, other, {
    baseEtag: (await readNodeForEdit(fs, other)).etag,
    implemented: true,
  });
  assert.equal("planned" in parseFrontmatter(confirmed.raw).data, false);
  await writeNodeDocument(fs, other, { baseEtag: confirmed.etag, planned: false });
  assert.equal("planned" in (await readNodeForEdit(fs, other)).frontmatter, false);
});

for (const continual of [false, true]) {
  test(`workspace scan ${continual ? "reports uncertainty after one retry" : "retries a changing node once"}`, async (t) => {
    const { fs, env, resource } = await fixture(t);
    const id = await createNode(env, { parentPath: "", name: "Racing", type: "goal", resource });
    const stable = await createNode(env, {
      parentPath: "",
      name: "Stable",
      type: "output",
      resource,
    });
    const observe = fs.observeMaterial.bind(fs);
    let races = 0;
    fs.observeMaterial = async (...args) => {
      if (args[1] === "Racing/Racing.md" && (continual || races === 0)) {
        races++;
        const parsed = parseFrontmatter(await fs.readFile("Racing/Racing.md"));
        parsed.data.description = `race ${races}`;
        await fs.writeFile(
          "Racing/Racing.md",
          serializeFrontmatter(parsed.data, parsed.body, parsed.keyOrder),
        );
      }
      return observe(...args);
    };
    const inspection = await inspectWorkspaceSync(fs);
    assert.equal(races, continual ? 2 : 1);
    assert.equal(inspection.nodes.find((node) => node.nodeId === stable)!.state, "synced");
    const raced = inspection.nodes.find((node) => node.nodeId === id)!;
    assert.equal(raced.state, continual ? "unanchored" : "ahead");
    assert.equal(
      Object.values(inspection.counts).reduce((a, b) => a + b, 0),
      2,
    );
    if (continual) {
      assert.equal(raced.uncertain, true);
      assert.match(raced.reasons[0]!, /uncertain/);
      assert.equal(inspection.requirementsWithoutOutputs.includes(id), false);
      assert.equal(inspection.unlinkedOutputs.length, 0);
    } else {
      assert.equal(inspection.unlinkedOutputs[0]!.nodeId, stable);
    }
  });
}

for (const stage of ["lookup", "final read"] as const) {
  for (const change of ["move", "resource"] as const) {
    test(`workspace scan refreshes output metadata after ${change} during ${stage}`, async (t) => {
      const { fs, env, resource, workspace } = await fixture(t);
      const id = await createNode(env, {
        parentPath: "",
        name: "Racing",
        type: "output",
        resource,
      });
      const updatedResource = pathToFileURL(path.join(workspace, "output.txt")).href;
      let changed = false;
      async function changeNode() {
        if (changed) return;
        changed = true;
        if (change === "move") await renameNode(env, id, "Moved");
        const before = await readNodeForEdit(fs, id);
        await writeNodeDocument(fs, id, {
          baseEtag: before.etag,
          frontmatter: { resource: updatedResource },
        });
      }
      if (stage === "lookup") {
        const read = fs.readFile.bind(fs);
        fs.readFile = async (filename) => {
          if (filename === "Racing/Racing.md") await changeNode();
          return read(filename);
        };
      } else {
        const observe = fs.observeMaterial.bind(fs);
        fs.observeMaterial = async (...args) => {
          if (args[1] === "Racing/Racing.md") await changeNode();
          return observe(...args);
        };
      }
      const inspection = await inspectWorkspaceSync(fs);
      const current = inspection.nodes.find((node) => node.nodeId === id)!;
      const unlinked = inspection.unlinkedOutputs.find((node) => node.nodeId === id)!;
      assert.equal(changed, true);
      assert.equal(current.state, "synced");
      assert.equal(current.uncertain, undefined);
      assert.equal(current.path, change === "move" ? "Moved" : "Racing");
      assert.equal(current.materials[0]!.resource, updatedResource);
      assert.equal(unlinked.path, current.path);
      assert.equal(unlinked.resource, updatedResource);
    });
  }

  for (const change of ["move", "remove"] as const) {
    test(`workspace scan handles node ${change} during ${stage}`, async (t) => {
      const { fs, env, resource } = await fixture(t);
      const id = await createNode(env, { parentPath: "", name: "Racing", type: "goal", resource });
      const stable = await createNode(env, {
        parentPath: "",
        name: "Stable",
        type: "prompt",
        resource,
      });
      let changed = false;
      async function changeNode() {
        if (changed) return;
        changed = true;
        if (change === "move") await renameNode(env, id, "Moved");
        else await fs.remove("Racing");
      }
      if (stage === "lookup") {
        const read = fs.readFile.bind(fs);
        fs.readFile = async (filename) => {
          if (filename === "Racing/Racing.md") await changeNode();
          return read(filename);
        };
      } else {
        const observe = fs.observeMaterial.bind(fs);
        fs.observeMaterial = async (...args) => {
          if (args[1] === "Racing/Racing.md") await changeNode();
          return observe(...args);
        };
      }
      const inspection = await inspectWorkspaceSync(fs);
      assert.equal(changed, true);
      assert.equal(inspection.nodes.find((node) => node.nodeId === stable)!.state, "synced");
      const raced = inspection.nodes.find((node) => node.nodeId === id)!;
      assert.equal(raced.state, change === "move" ? "ahead" : "unanchored");
      assert.equal(raced.path, change === "move" ? "Moved" : "Racing");
      assert.equal(
        Object.values(inspection.counts).reduce((a, b) => a + b, 0),
        2,
      );
      if (change === "remove") {
        assert.equal(raced.uncertain, true);
        assert.match(raced.reasons[0]!, /uncertain/);
        assert.equal(inspection.requirementsWithoutOutputs.includes(id), false);
      } else assert.equal(raced.uncertain, undefined);
    });
  }

  test(`workspace scan preserves unrelated I/O errors during ${stage}`, async (t) => {
    const { fs, env, resource } = await fixture(t);
    await createNode(env, { parentPath: "", name: "Racing", type: "prompt", resource });
    const read = fs.readFile.bind(fs);
    let finalRead = false;
    const observe = fs.observeMaterial.bind(fs);
    fs.observeMaterial = async (...args) => {
      finalRead = true;
      return observe(...args);
    };
    for (const code of ["EIO", "EACCES"]) {
      finalRead = false;
      const failure = Object.assign(new Error(`unrelated ${code}`), { code });
      fs.readFile = async (filename) => {
        if (filename === "Racing/Racing.md" && (stage === "lookup" || finalRead)) throw failure;
        return read(filename);
      };
      await assert.rejects(inspectWorkspaceSync(fs), (error) => error === failure);
    }
  });
}
