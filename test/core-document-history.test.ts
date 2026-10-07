import { NodeFs } from "../src/fs/node-fs.js";
import { readWorkspaceSettings } from "../src/core/workspace-settings.js";
import { readNode, readNodeForEdit, listNodes, searchNodes } from "../src/core/node-query.js";
import {
  createRoleContext,
  editRoleContext,
  readRoleContext,
  listRoleContexts,
} from "../src/core/role-context.js";
import { inspectNodeSync, confirmNodeSync } from "../src/core/node-sync.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { initializeTentWorkspace } from "../src/fs/workspace-init.js";
import { renameNode, deleteNode } from "../src/core/ops.js";
import { withTentMutation } from "../src/core/adapter.js";
import { DELETE_PENDING_PATH } from "../src/core/delete-recovery.js";
import type { DocumentVersion } from "../src/core/git-history.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { NODE_MOVE_PENDING_PATH } from "../src/core/node-move-recovery.js";
import { contentEtag } from "../src/core/etag.js";
import { parseFrontmatter } from "../src/core/frontmatter.js";
import { NodeWriteError, writeNodeDocument } from "../src/core/node-document-write.js";

async function fixture(t: TestContext) {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "history-service-"));
  const workspace = path.join(root, "workspace");
  await initializeTentWorkspace(workspace);
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  const systemRoot = path.join(workspace, ".tent"),
    adapter = new NodeFs(systemRoot);
  const { workspaceId: savedId } = await readWorkspaceSettings(adapter),
    workspaceId = savedId!;
  const mount = {
    systemRoot,
    env: {
      fs: adapter,
      tentRoot: systemRoot,
      tentName: "history",
      clock: { now: () => new Date().toISOString() },
    },
  };
  const git = async (...args: string[]) =>
    (
      await promisify(execFile)("git", ["-C", mount.systemRoot, ...args], { windowsHide: true })
    ).stdout.trim();
  // Editor-written files are deliberately outside a Tent mutation.
  await adapter.writeFile("A/A.md", "---\nid: node-alpha\ntype: prompt\n---\nOriginal A\n");
  await adapter.writeFile("B/B.md", "---\nid: node-bravo\ntype: prompt\n---\nUnobserved B\n");
  return { root, workspace, workspaceId, mount, adapter, git };
}

for (const kind of ["Node", "Role"] as const) {
  test(`${kind} normalization rejects intervening editor bytes before capture or save`, async (t) => {
    const { adapter, mount, git } = await fixture(t);
    const selected =
      kind === "Node"
        ? { id: "node-alpha", path: "A/A.md" }
        : { id: "role-review", path: "roles/role-review.md" };
    if (kind === "Role")
      await createRoleContext(adapter, {
        roleId: selected.id,
        title: "Review",
        body: "Original role",
      });
    const original = await adapter.readFile(selected.path);
    await adapter.history.captureUnlocked([{ path: selected.path, raw: original }]);
    const head = await git("rev-parse", "HEAD");
    const external = original + "\nUSER EXTERNAL EDIT";
    const header = adapter.readFrontmatter.bind(adapter);
    let peerReads = 0;
    adapter.readFrontmatter = async (file) => {
      const result = await header(file);
      // Node lookup scans once before CAS; canonicalization performs the next scan.
      if (file === "B/B.md" && ++peerReads === (kind === "Node" ? 2 : 1))
        await fs.writeFile(path.join(mount.systemRoot, selected.path), external);
      return result;
    };
    const send = (baseEtag: string) =>
      kind === "Node"
        ? writeNodeDocument(adapter, selected.id, { baseEtag, body: "new [peer](node-bravo)" })
        : editRoleContext(adapter, selected.id, { baseEtag, body: "new [peer](node-bravo)" });
    try {
      await assert.rejects(send(contentEtag(original)), (error) => {
        if (kind === "Node") {
          assert.ok(error instanceof NodeWriteError);
          assert.equal(error.code, "ETAG_CONFLICT");
        } else assert.match(String(error), /Role context changed/);
        return true;
      });
    } finally {
      adapter.readFrontmatter = header;
    }
    assert.equal(await adapter.readFile(selected.path), external);
    assert.equal(await git("rev-parse", "HEAD"), head);
    const saved = await send(contentEtag(external));
    assert.ok(saved.version);
    const finalRaw = await adapter.readFile(selected.path);
    assert.equal(parseFrontmatter(finalRaw).body, "new [peer](../B/B.md)");
    assert.equal(await adapter.history.read(saved.version), finalRaw);
  });
}

test("independent Core writers share CAS, selected reads and exact Git history", async (t) => {
  const { workspaceId, adapter, mount } = await fixture(t);
  const raw = await adapter.readFile("A/A.md"),
    baseEtag = contentEtag(raw);
  const read = adapter.readFile.bind(adapter);
  let unrelatedReads = 0;
  adapter.readFile = async (file) => {
    if (file === "B/B.md") unrelatedReads++;
    return read(file);
  };
  const results = await Promise.allSettled([
    writeNodeDocument(adapter, "node-alpha", { baseEtag, body: "Core fact" }),
    writeNodeDocument(new NodeFs(mount.systemRoot), "node-alpha", { baseEtag, body: "other fact" }),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
    results
      .map((result) => (result.status === "rejected" ? String(result.reason) : "saved"))
      .join("; "),
  );
  const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert.match(String(rejected.reason), /etag conflict|already running another write operation/);
  assert.equal(unrelatedReads, 0);
  await assert.rejects(
    writeNodeDocument(adapter, "node-alpha", { baseEtag, body: "Stale Core fact" }),
    /etag conflict/,
  );
  await assert.rejects(
    writeNodeDocument(adapter, "node-alpha", { baseEtag, body: "Stale other fact" }),
    /etag conflict/,
  );
  const current = await adapter.readFile("A/A.md");
  const saved = await writeNodeDocument(adapter, "node-alpha", {
    baseEtag: contentEtag(current),
    raw: current,
  });
  assert.equal(saved.changed, false);
  assert.ok(saved.version);
  assert.equal(await adapter.history!.read(saved.version), current);
  assert.equal(await adapter.history!.read({ ...saved.version, path: "A/A.md" }), saved.raw);
  assert.equal(unrelatedReads, 0);
});

test("public lifecycle commands require an explicit archive commit for undo", async (t) => {
  const h = await fixture(t),
    { workspaceId, adapter, workspace } = h;
  const archived = await runNodeCommand("archive", ["node-alpha"], { workspace, json: true });
  assert.equal(archived.exitCode, 0, archived.stderr);
  const result = JSON.parse(archived.stdout);
  assert.match(result.commit, /^[a-f0-9]{40,64}$/);
  const edit = await readNodeForEdit(adapter, "node-alpha");
  assert.equal(edit.status, "deprecated");
  const missing = await runNodeCommand("restore", ["node-alpha"], { workspace, json: true });
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /archive-commit/);
  assert.equal(await adapter.readFile("A/A.md"), edit.raw);
  const restored = await runNodeCommand(
    "restore",
    ["node-alpha", "--archive-commit", result.commit],
    { workspace, json: true },
  );
  assert.equal(restored.exitCode, 0, restored.stderr);
  const current = await readNodeForEdit(adapter, "node-alpha");
  assert.equal(current.status, "stable");
  assert.equal(current.frontmatter.status, undefined);
  assert.equal(current.body, "Original A\n");
});

test("public standard material edits retain exact history and reject invalid source shapes before saving", async (t) => {
  const h = await fixture(t),
    { workspaceId, adapter, git } = h;
  const original = await readNodeForEdit(adapter, "node-alpha");
  const sources = [
    { resource: "../B/B.md", title: "first", custom: [2, 1] },
    { resource: "user interviews" },
    { resource: "../B/B.md", title: "second" },
  ];
  const result = await runNodeCommand(
    "write",
    [
      "node-alpha",
      "--input-json",
      JSON.stringify({
        baseEtag: original.etag,
        frontmatter: {
          resource: "src/main.ts",
          sources: sources.map((source) =>
            source.resource === "../B/B.md" ? { ...source, resource: "node-bravo" } : source,
          ),
        },
        readBack: true,
      }),
    ],
    { workspace: h.workspace, json: true },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const saved = JSON.parse(result.stdout);
  assert.deepEqual(saved.readBack.sources, sources);
  const search = await runNodeCommand("search", ["--resource", "src/main.ts"], {
    workspace: h.workspace,
    json: true,
  });
  assert.equal(search.exitCode, 0, search.stderr);
  assert.equal(JSON.parse(search.stdout).items[0].nodeId, "node-alpha");
  assert.equal(saved.readBack.resource, "../../src/main.ts");
  const raw = await adapter.readFile("A/A.md");
  assert.equal(await adapter.history!.read(saved.version), raw);
  const head = await git("rev-parse", "HEAD");
  for (const frontmatter of [
    { resource: 42 },
    { sources: [{ title: "missing" }] },
    { sources: "wrong" },
  ]) {
    await assert.rejects(
      writeNodeDocument(adapter, "node-alpha", { baseEtag: saved.etag, frontmatter }),
    );
    assert.equal(await adapter.readFile("A/A.md"), raw);
    assert.equal(await git("rev-parse", "HEAD"), head);
  }
  await writeNodeDocument(adapter, "node-alpha", {
    baseEtag: saved.etag,
    frontmatter: { sources },
  });
  assert.equal(await git("rev-parse", "HEAD"), head);
  await renameNode(h.mount.env, "node-bravo", "New");
  const next = parseFrontmatter(await adapter.readFile("A/A.md"));
  assert.deepEqual(
    next.data.sources,
    sources.map((source) =>
      source.resource === "../B/B.md" ? { ...source, resource: "../New/New.md" } : source,
    ),
  );
  const historical = await readNode(adapter, workspaceId, {
    nodeId: "node-alpha",
    ...{ view: "raw", version: saved.version },
  });
  assert.ok("text" in historical.node);
  assert.equal(historical.node.text, raw);
});

test("explicit read capture and Core saves retain only selected documents; Git descriptors survive rename and deletion", async (t) => {
  const h = await fixture(t),
    { workspaceId, adapter, git } = h;
  await listNodes(adapter, workspaceId, {});
  await readNode(adapter, workspaceId, { nodeId: "node-alpha", ...{ view: "summary" } });
  await searchNodes(adapter, workspaceId, { query: "Original" });
  await assert.rejects(git("rev-parse", "--verify", "HEAD"));
  const uncaptured = await readNodeForEdit(adapter, "node-alpha");
  assert.equal(uncaptured.version, undefined);
  await assert.rejects(git("rev-parse", "--verify", "HEAD"));
  const original = await readNodeForEdit(adapter, "node-alpha", { capture: true });
  assert.ok(original.version);
  assert.equal(await git("ls-tree", "-r", "--name-only", "HEAD"), "A/A.md");
  assert.equal(await adapter.readFile("A/A.md"), original.raw);
  await git("add", "B/B.md");
  const unselected = await adapter.readFile("B/B.md");
  const saved = (await writeNodeDocument(adapter, original.nodeId, {
    baseEtag: original.etag,
    body: "Saved A",
  })) as { etag: string; version: DocumentVersion };
  assert.equal(await adapter.history!.read(saved.version), await adapter.readFile("A/A.md"));
  assert.equal(await git("ls-tree", "-r", "--name-only", "HEAD"), "A/A.md");
  assert.equal(await git("write-tree"), await git("rev-parse", "HEAD^{tree}"));
  assert.equal(await adapter.readFile("B/B.md"), unselected);
  assert.match(await git("status", "--porcelain"), /\?\? B\//);
  const head = await git("rev-parse", "HEAD");
  await writeNodeDocument(adapter, original.nodeId, { baseEtag: saved.etag, body: "Saved A" });
  await readNode(adapter, workspaceId, { nodeId: original.nodeId, ...{} });
  assert.equal(await git("rev-parse", "HEAD"), head);
  await adapter.writeFile("A/A.md", original.raw.replace("Original A", "Editor A"));
  await readNode(adapter, workspaceId, { nodeId: original.nodeId, ...{ view: "summary" } });
  assert.equal(await git("rev-parse", "HEAD"), head);
  const read = await readNode(adapter, workspaceId, {
    nodeId: original.nodeId,
    ...{ view: "raw", capture: true },
  });
  assert.ok("text" in read.node && read.node.version);
  assert.match(await adapter.history!.read(read.node.version), /Editor A/);
  const edited = await readNodeForEdit(adapter, original.nodeId);
  await writeNodeDocument(adapter, original.nodeId, { baseEtag: edited.etag, body: "Core save" });
  assert.match(await git("show", "HEAD:A/A.md"), /Core save/);
  await renameNode(h.mount.env, original.nodeId, "Renamed");
  const renamed = await readNodeForEdit(adapter, original.nodeId, { capture: true });
  assert.ok(renamed.version);
  assert.equal(await git("ls-tree", "-r", "--name-only", "HEAD"), "Renamed/Renamed.md");
  const diff = await runNodeCommand(
    "diff",
    ["--from-json", JSON.stringify(original.version), "--to-json", JSON.stringify(renamed.version)],
    { workspace: h.workspace, json: true },
  );
  assert.equal(diff.exitCode, 0, diff.stderr);
  assert.equal(JSON.parse(diff.stdout).pathChanged, true);
  assert.match(JSON.parse(diff.stdout).text, /Core save/);
  await deleteNode(h.mount.env, original.nodeId);
  await git("gc", "--prune=now");
  const history = await runNodeCommand(
    "get",
    [original.nodeId, "--version-json", JSON.stringify(original.version), "--view", "raw"],
    { workspace: h.workspace, json: true },
  );
  assert.equal(history.exitCode, 0, history.stderr);
  assert.equal(JSON.parse(history.stdout).node.text, original.raw);
  await assert.rejects(
    readNode(adapter, workspaceId, { nodeId: "node-bravo", ...{ version: original.version } }),
    /another Node/,
  );
});

test("batch writes share a commit, Role reads capture explicitly, and Git failures never report a successful save", async (t) => {
  const h = await fixture(t),
    { adapter, git, workspaceId } = h;
  // New identities in one operation have one history commit.
  await withTentMutation(adapter, async () => {
    await adapter.writeFile("C/C.md", "---\nid: node-charlie\n---\nC");
    await adapter.writeFile("D/D.md", "---\nid: node-delta\n---\nD");
  });
  assert.equal(await git("rev-list", "--count", "HEAD"), "1");
  assert.equal(await git("ls-tree", "-r", "--name-only", "HEAD"), "C/C.md\nD/D.md");
  const role = await createRoleContext(adapter, { title: "Writer", body: "" });
  const rolePath = `roles/${role.roleId}.md`;
  await adapter.writeFile(
    rolePath,
    `---\ntype: role\nid: ${role.roleId}\ntitle: Writer\n---\nEditor role context`,
  );
  const head = await git("rev-parse", "HEAD");
  await listRoleContexts(adapter);
  assert.equal(await git("rev-parse", "HEAD"), head);
  await readRoleContext(adapter, role.roleId);
  assert.equal(await git("rev-parse", "HEAD"), head);
  const roleRead = { document: await readRoleContext(adapter, role.roleId, { capture: true }) };
  assert.ok(roleRead.document.version);
  assert.equal(await adapter.history!.read(roleRead.document.version), roleRead.document.raw);
  const original = await readNodeForEdit(adapter, "node-alpha");
  const capture = adapter.history!.captureUnlocked.bind(adapter.history);
  adapter.history!.captureUnlocked = async (changes, metadata) => {
    if (changes.some((c) => c.raw?.includes("Capture failure")))
      throw new Error("injected Git failure");
    return capture(changes, metadata);
  };
  await assert.rejects(
    writeNodeDocument(adapter, original.nodeId, {
      baseEtag: original.etag,
      body: "Capture failure",
    }),
    /injected Git failure/,
  );
  adapter.history!.captureUnlocked = capture;
  assert.equal(await adapter.readFile("A/A.md"), original.raw);
  const retry = await readNodeForEdit(adapter, original.nodeId, { capture: true });
  assert.ok(retry.version);
  assert.equal(await adapter.history!.read(retry.version), retry.raw);
  // Crash after the logical directory move: next mutation must finish deletion
  // in Git even though that retry never moves the original live directory.
  const write = adapter.writeFile.bind(adapter);
  adapter.writeFile = async (file, raw) => {
    if (file === DELETE_PENDING_PATH && JSON.parse(raw).committed)
      throw new Error("interrupted delete");
    return write(file, raw);
  };
  await assert.rejects(deleteNode(h.mount.env, original.nodeId), /interrupted delete/);
  adapter.writeFile = write;
  await withTentMutation(adapter, async () => {});
  assert.ok(!(await git("ls-tree", "-r", "--name-only", "HEAD")).includes("A/A.md"));
  assert.equal(await adapter.history!.read(retry.version), retry.raw);
});

test("material versions are automatic, body-preserving, local and captured with the Node", async (t) => {
  const h = await fixture(t),
    { adapter } = h;
  const target = "attachments/checked.txt";
  await adapter.writeFile(target, "material one");
  let node = await readNodeForEdit(adapter, "node-alpha");
  const originalBody = parseFrontmatter(node.raw).body;
  assert.equal((await inspectNodeSync(adapter, node.nodeId)).state, "unanchored");
  const readFile = adapter.readFile.bind(adapter);
  const bodyReads: string[] = [];
  adapter.readFile = async (file) => {
    if (file.endsWith(".md")) bodyReads.push(file);
    return readFile(file);
  };
  await writeNodeDocument(adapter, node.nodeId, {
    baseEtag: node.etag,
    frontmatter: { resource: "/attachments/checked.txt" },
  });
  assert.equal((await inspectNodeSync(adapter, node.nodeId)).state, "synced");
  assert.equal(
    bodyReads.includes("B/B.md"),
    false,
    "checking one Node must not read unrelated bodies",
  );
  node = await readNodeForEdit(adapter, node.nodeId);
  const firstRecord = (await adapter.history.nodeRecords())[node.nodeId]!;
  const firstHash = firstRecord.materials[0]!.version!;
  assert.match(firstHash, /^[a-f0-9]{64}$/);
  assert.equal(parseFrontmatter(node.raw).data.sync, undefined);
  const firstConfirmed = await confirmNodeSync(adapter, node.nodeId, { baseEtag: node.etag });
  assert.equal(parseFrontmatter(firstConfirmed.raw).body, originalBody);
  assert.deepEqual(parseFrontmatter(firstConfirmed.raw).data.generated, node.frontmatter.generated);
  assert.ok(parseFrontmatter(firstConfirmed.raw).data.verified);
  assert.deepEqual((await adapter.history.nodeRecords())[node.nodeId], firstRecord);
  await adapter.writeFile(target, "material two");
  assert.equal((await inspectNodeSync(adapter, node.nodeId)).state, "behind");
  const confirmed = await confirmNodeSync(adapter, node.nodeId, { baseEtag: firstConfirmed.etag });
  assert.equal((await inspectNodeSync(adapter, node.nodeId)).state, "synced");
  assert.equal(parseFrontmatter(confirmed.raw).body, originalBody);
  await assert.rejects(
    confirmNodeSync(adapter, node.nodeId, { baseEtag: node.etag }),
    /etag conflict/i,
  );
  await adapter.remove(target);
  assert.equal((await inspectNodeSync(adapter, node.nodeId)).state, "behind");
  await adapter.writeFile(target, "material two");
  await renameNode(h.mount.env, node.nodeId, "Moved");
  assert.equal((await inspectNodeSync(adapter, node.nodeId)).state, "synced");
  const retained = (
    await promisify(execFile)("git", ["-C", h.mount.systemRoot, "show", "HEAD:Moved/Moved.md"], {
      windowsHide: true,
    })
  ).stdout;
  assert.equal(parseFrontmatter(retained).data.sync, undefined);
  assert.notEqual(
    (await adapter.history.nodeRecords())[node.nodeId]!.materials[0]!.version,
    firstHash,
  );
  assert.equal(parseFrontmatter(retained).body, originalBody);
  adapter.readFile = readFile;
});

test("public rename rejects YAML aliases before changing unknown metadata or moving files", async (t) => {
  const h = await fixture(t);
  await readNodeForEdit(h.adapter, "node-alpha", { capture: true });
  for (const custom of ["custom: *items", "custom:\n  nested: *items"]) {
    const raw = `---\nid: node-bravo\ntype: prompt\nsources: &items\n  - resource: /A/A.md\n    title: evidence\n${custom}\n---\nOriginal body\n`;
    await h.adapter.writeFile("B/B.md", raw);
    const before = await h.adapter.readFile("A/A.md"),
      head = await h.git("rev-parse", "HEAD");
    await assert.rejects(renameNode(h.mount.env, "node-alpha", "Moved"), /alias/i);
    assert.equal(await h.adapter.readFile("A/A.md"), before);
    assert.equal(await h.adapter.readFile("B/B.md"), raw);
    assert.equal(await h.adapter.exists("Moved"), false);
    assert.equal(await h.git("rev-parse", "HEAD"), head);
  }
});

test("preimage Git capture rejects external edits before write, binary write, move or remove", async (t) => {
  const h = await fixture(t),
    { adapter, workspaceId } = h;
  const capture = adapter.history!.captureUnlocked.bind(adapter.history);
  for (const operation of ["write", "binary", "move", "remove"] as const) {
    const raw = `---\nid: node-alpha\ntype: prompt\n---\nBefore ${operation}\n`;
    const edited = raw.replace(`Before ${operation}`, `OTHER_EDITOR ${operation}`);
    await adapter.writeFile("A/A.md", raw);
    const summary = await readNode(adapter, workspaceId, {
      nodeId: "node-alpha",
      ...{ view: "summary" },
    });
    assert.equal("etag" in summary.node, false);
    let injected = false;
    adapter.history!.captureUnlocked = async (changes) => {
      const result = await capture(changes);
      if (!injected && changes.some((c) => c.path === "A/A.md" && c.raw === raw)) {
        injected = true;
        await fs.writeFile(path.join(h.mount.systemRoot, "A/A.md"), edited);
      }
      return result;
    };
    const act = () =>
      operation === "write"
        ? writeNodeDocument(adapter, "node-alpha", {
            baseEtag: contentEtag(raw),
            body: "MODEL_EDIT",
          })
        : withTentMutation(adapter, async () => {
            if (operation === "binary")
              await adapter.writeBinary("A/A.md", Buffer.from(raw + "MODEL_EDIT"));
            if (operation === "move") await adapter.move("A", "Moved");
            if (operation === "remove") await adapter.remove("A");
          });
    await assert.rejects(act, /Document changed during Git capture/, operation);
    adapter.history!.captureUnlocked = capture;
    assert.equal(injected, true, operation);
    assert.equal(await adapter.readFile("A/A.md"), edited, operation);
    assert.equal(await adapter.exists("Moved"), false);
  }
});

test("same-value metadata saves capture exact editor bytes with no document writes", async (t) => {
  const h = await fixture(t),
    { adapter, workspaceId, git } = h;
  const write = adapter.writeFile.bind(adapter);
  let documentWrites = 0;
  adapter.writeFile = async (file, raw) => {
    if (file === "A/A.md") documentWrites++;
    return write(file, raw);
  };
  const saves = [
    { method: "type", frontmatter: { type: "prompt" } },
    { method: "tags", frontmatter: { tags: ["keep"] } },
    { method: "status", frontmatter: { status: "stable" } },
  ];
  for (const save of saves) {
    const raw = `\uFEFF---\r\nid: node-alpha\r\ntype: prompt # keep comment\r\ntags: [keep]\r\nstatus: stable\r\n---\r\nEditor ${save.method}\r\n`;
    await fs.writeFile(path.join(h.mount.systemRoot, "A/A.md"), raw);
    const summary = await readNode(adapter, workspaceId, {
      nodeId: "node-alpha",
      ...{ view: "summary" },
    });
    assert.equal("etag" in summary.node, false);
    // The external editor already observed these bytes; discovery must not capture them first.
    const send = (baseEtag = contentEtag(raw)) =>
      writeNodeDocument(adapter, "node-alpha", { baseEtag, frontmatter: save.frontmatter });
    await assert.rejects(send("stale"), /etag conflict/);
    const saved = await send();
    assert.ok(saved.version);
    assert.equal(await adapter.history!.read(saved.version), raw, save.method);
    const head = await git("rev-parse", "HEAD");
    await send();
    assert.equal(await git("rev-parse", "HEAD"), head, save.method);
    assert.equal(await adapter.readFile("A/A.md"), raw, save.method);
  }
  assert.equal(documentWrites, 0);
  const editable = await readNodeForEdit(adapter, "node-alpha");
  const changed = await writeNodeDocument(adapter, "node-alpha", {
    baseEtag: editable.etag,
    frontmatter: { type: "output" },
  });
  assert.ok(changed.version);
  assert.equal(await adapter.history!.read(changed.version), await adapter.readFile("A/A.md"));
});

for (const stage of [
  "delete-before",
  "delete-after",
  "delete-conflict",
  "move",
  "corrupt-order",
] as const) {
  test(`material inspect preserves document and recovery files during pending ${stage}`, async (t) => {
    const h = await fixture(t),
      { adapter, workspaceId } = h;
    const write = adapter.writeFile.bind(adapter),
      move = adapter.move.bind(adapter);
    if (stage === "corrupt-order") {
      await adapter.writeFile("order.json", "invalid JSON");
    } else if (stage === "move") {
      // Interrupt after the directory move; recovery also stops, retaining the real plan.
      adapter.move = async (from, to) => {
        if (from.startsWith("Moved")) throw new Error("injected pending move");
        return move(from, to);
      };
      await assert.rejects(renameNode(h.mount.env, "node-bravo", "Moved"), /injected pending move/);
      adapter.move = move;
      assert.equal(await adapter.exists(NODE_MOVE_PENDING_PATH), true);
    } else {
      if (stage === "delete-before") {
        adapter.move = async (from, to) => {
          if (from === "B") throw new Error("injected pending delete");
          return move(from, to);
        };
      } else {
        adapter.writeFile = async (file, raw) => {
          if (file === DELETE_PENDING_PATH && JSON.parse(raw).committed)
            throw new Error("injected pending delete");
          return write(file, raw);
        };
      }
      await assert.rejects(deleteNode(h.mount.env, "node-bravo"), /injected pending delete/);
      adapter.move = move;
      adapter.writeFile = write;
      assert.equal(await adapter.exists(DELETE_PENDING_PATH), true);
      if (stage === "delete-conflict")
        await adapter.writeFile("order.json", '{"__root__":["node-alpha"]}\n');
    }
    const snapshot = async () => {
      const entries: Record<string, string> = {};
      const walk = async (dir: string) => {
        for (const entry of await fs.readdir(path.join(h.mount.systemRoot, dir), {
          withFileTypes: true,
        })) {
          if (
            entry.name === ".git" ||
            entry.name === "mutation.lock" ||
            entry.name.startsWith("mutation.lock.guard")
          )
            continue;
          const file = path.posix.join(dir, entry.name);
          if (entry.isDirectory()) {
            entries[file + "/"] = "directory";
            await walk(file);
          } else
            entries[file] = (await fs.readFile(path.join(h.mount.systemRoot, file))).toString(
              "base64",
            );
        }
      };
      await walk("");
      return entries;
    };
    const before = await snapshot();
    const inspect = () => inspectNodeSync(adapter, "node-alpha");
    if (stage === "corrupt-order") {
      await assert.rejects(inspect, /requires explicit repair/);
      assert.deepEqual(await snapshot(), before);
      return;
    }
    const result = await inspect();
    assert.equal(result.state, "unanchored");
    assert.deepEqual(await snapshot(), before);
    if (stage === "delete-conflict")
      await assert.rejects(
        withTentMutation(adapter, async () => {}),
        /Pending deletion conflict/,
      );
    else {
      await withTentMutation(adapter, async () => {});
      assert.equal(
        await adapter.exists(stage === "move" ? NODE_MOVE_PENDING_PATH : DELETE_PENDING_PATH),
        false,
      );
    }
  });
}
