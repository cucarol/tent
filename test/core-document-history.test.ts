import { openTestFs, removeTestFixture } from "./node-fs.js";
import { testScratchRoot } from "./scratch.js";
import { readWorkspaceSettings } from "../src/core/workspace/workspace-settings.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { initializeFixtureWorkspace } from "./scratch.js";
import { renameNode, deleteNode } from "../src/core/graph/ops.js";
import { withTentMutation } from "../src/core/store/adapter.js";
import { DELETE_PENDING_PATH } from "../src/core/store/delete-recovery.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { NODE_MOVE_PENDING_PATH } from "../src/core/store/node-move-recovery.js";
import { parseFrontmatter } from "../src/core/base/frontmatter.js";
import { editNode, readNodeFile } from "./node-edit.js";
import { readNodeVersion } from "../src/core/read/node-version.js";

async function fixture(t: TestContext) {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "history-service-"));
  const workspace = path.join(root, "workspace");
  await initializeFixtureWorkspace(workspace);
  t.after(async () => {
    await adapter.close();
    await removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });
  const systemRoot = path.join(workspace, ".tent"),
    adapter = openTestFs(systemRoot);
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
  // Editor-written files are deliberately outside a Tent mutation.
  await adapter.writeFile("A/A.md", "---\nid: node-alpha\ntype: prompt\n---\nOriginal A\n");
  await adapter.writeFile("B/B.md", "---\nid: node-bravo\ntype: prompt\n---\nUnobserved B\n");
  return { root, workspace, workspaceId, mount, adapter };
}

test("public archive retains its event and deprecated document bytes", async (t) => {
  const h = await fixture(t),
    { adapter, workspace } = h;
  const archived = await runNodeCommand("archive", ["node-alpha"], { workspace, json: true });
  assert.equal(archived.exitCode, 0, archived.stderr);
  const result = JSON.parse(archived.stdout);
  assert.match(result.commit, /^[a-f0-9]{40,64}$/);
  const edit = await readNodeFile(adapter, "node-alpha");
  assert.equal(edit.status, "deprecated");
  assert.equal(edit.body, "Original A\n");
  assert.equal(await adapter.history!.read({ commit: result.commit, path: "A/A.md" }), edit.raw);
});

test("Core material edits retain exact history and reject invalid source shapes before saving", async (t) => {
  const h = await fixture(t),
    { workspaceId, adapter } = h;
  const original = await readNodeFile(adapter, "node-alpha");
  const sources = [
    { resource: "../B/B.md", title: "first", custom: [2, 1] },
    { resource: "user interviews" },
    { resource: "../B/B.md", title: "second" },
  ];
  const saved = await editNode(adapter, "node-alpha", {
    frontmatter: { resource: "../../src/main.ts", sources },
  });
  assert.deepEqual(parseFrontmatter(saved.raw).data.sources, sources);
  assert.equal(parseFrontmatter(saved.raw).data.resource, "../../src/main.ts");
  const raw = await adapter.readFile("A/A.md");
  assert.ok(saved.version);
  assert.equal(await adapter.history!.read(saved.version), raw);
  const head = await adapter.history.currentCommit();
  for (const frontmatter of [
    { resource: 42 },
    { sources: [{ title: "missing" }] },
    { sources: "wrong" },
  ]) {
    await assert.rejects(editNode(adapter, "node-alpha", { frontmatter }));
    assert.equal(await adapter.readFile("A/A.md"), raw);
    assert.equal(await adapter.history.currentCommit(), head);
  }
  await editNode(adapter, "node-alpha", {
    frontmatter: { sources },
  });
  assert.equal(await adapter.history.currentCommit(), head);
  await renameNode(h.mount.env, "node-bravo", "New");
  const next = parseFrontmatter(await adapter.readFile("A/A.md"));
  assert.deepEqual(
    next.data.sources,
    sources.map((source) =>
      source.resource === "../B/B.md" ? { ...source, resource: "../New/New.md" } : source,
    ),
  );
  assert.equal((await readNodeVersion(adapter, "node-alpha", saved.version)).text, raw);
});

test("batch writes share a commit and history failures never report a successful save", async (t) => {
  const h = await fixture(t),
    { adapter } = h;
  // New identities in one operation have one history commit.
  await withTentMutation(adapter, async () => {
    await adapter.writeFile("C/C.md", "---\nid: node-charlie\n---\nC");
    await adapter.writeFile("D/D.md", "---\nid: node-delta\n---\nD");
  });
  assert.equal(String((await adapter.history.changesInRange()).length), "1");
  assert.equal((await adapter.retainedDocumentPaths())!.join("\n"), "C/C.md\nD/D.md");
  const original = await readNodeFile(adapter, "node-alpha");
  const capture = adapter.history!.captureUnlocked.bind(adapter.history);
  adapter.history!.captureUnlocked = async (changes, metadata) => {
    if (changes.some((c) => c.raw?.includes("Capture failure")))
      throw new Error("injected history failure");
    return capture(changes, metadata);
  };
  await assert.rejects(
    editNode(adapter, original.nodeId, {
      body: "Capture failure",
    }),
    /injected history failure/,
  );
  adapter.history!.captureUnlocked = capture;
  assert.match(await adapter.readFile("A/A.md"), /Capture failure/);
  const retry = await readNodeFile(adapter, original.nodeId, { capture: true });
  assert.ok(retry.version);
  assert.match(retry.raw, /Capture failure/);
  assert.equal(await adapter.history!.read(retry.version), retry.raw);
  // An unpublished deletion now shares the durable transaction rollback.
  const write = adapter.writeFile.bind(adapter);
  adapter.writeFile = async (file, raw) => {
    if (file === DELETE_PENDING_PATH && JSON.parse(raw).committed)
      throw new Error("interrupted delete");
    return write(file, raw);
  };
  await assert.rejects(deleteNode(h.mount.env, original.nodeId), /interrupted delete/);
  adapter.writeFile = write;
  await withTentMutation(adapter, async () => {});
  assert.ok((await adapter.retainedDocumentPaths())!.join("\n").includes("A/A.md"));
  assert.equal(await adapter.readFile("A/A.md"), retry.raw);
  await deleteNode(h.mount.env, original.nodeId);
  assert.ok(!(await adapter.retainedDocumentPaths())!.join("\n").includes("A/A.md"));
  assert.equal(await adapter.history!.read(retry.version), retry.raw);
});

test("material declarations and opaque metadata retain exact Node history without reading project bytes", async (t) => {
  const { adapter } = await fixture(t);
  const original = await readNodeFile(adapter, "node-alpha");
  const generated = { imported: ["opaque", false], by: "not an actor", at: "not a timestamp" };
  const provenance = { arbitrary: ["leave", 17, false] };
  const readFile = adapter.readFile.bind(adapter);
  const reads: string[] = [];
  adapter.readFile = async (file) => {
    reads.push(file);
    return readFile(file);
  };
  const saved = await editNode(adapter, original.nodeId, {
    frontmatter: { resource: "../../not-present.txt", generated, provenance },
  });
  assert.equal(parseFrontmatter(saved.raw).body, original.body);
  assert.deepEqual(parseFrontmatter(saved.raw).data.generated, generated);
  assert.deepEqual(parseFrontmatter(saved.raw).data.provenance, provenance);
  assert.equal(
    reads.some((file) => file.includes("not-present")),
    false,
  );
  assert.ok(saved.version);
  assert.equal(await adapter.history.read(saved.version), saved.raw);
  const changed = await editNode(adapter, original.nodeId, {
    body: "Changed body",
  });
  assert.deepEqual(parseFrontmatter(changed.raw).data.provenance, provenance);
  assert.equal(parseFrontmatter(changed.raw).data.resource, "../../not-present.txt");
  adapter.readFile = readFile;
});

test("public rename rejects YAML aliases before changing unknown metadata or moving files", async (t) => {
  const h = await fixture(t);
  await readNodeFile(h.adapter, "node-alpha", { capture: true });
  for (const custom of ["custom: *items", "custom:\n  nested: *items"]) {
    const raw = `---\nid: node-bravo\ntype: prompt\nsources: &items\n  - resource: /A/A.md\n    title: evidence\n${custom}\n---\nOriginal body\n`;
    await h.adapter.writeFile("B/B.md", raw);
    const before = await h.adapter.readFile("A/A.md"),
      head = await h.adapter.history.currentCommit();
    await assert.rejects(renameNode(h.mount.env, "node-alpha", "Moved"), /alias/i);
    assert.equal(await h.adapter.readFile("A/A.md"), before);
    assert.equal(await h.adapter.readFile("B/B.md"), raw);
    assert.equal(await h.adapter.exists("Moved"), false);
    assert.equal(await h.adapter.history.currentCommit(), head);
  }
});

test("preimage history capture rejects external edits before binary write, move or remove", async (t) => {
  const h = await fixture(t),
    { adapter, workspaceId } = h;
  const capture = adapter.history!.captureUnlocked.bind(adapter.history);
  for (const operation of ["binary", "move", "remove"] as const) {
    const raw = `---\nid: node-alpha\ntype: prompt\n---\nBefore ${operation}\n`;
    const edited = raw.replace(`Before ${operation}`, `OTHER_EDITOR ${operation}`);
    await adapter.writeFile("A/A.md", raw);
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
      withTentMutation(adapter, async () => {
        if (operation === "binary")
          await adapter.writeBinary("A/A.md", Buffer.from(raw + "MODEL_EDIT"));
        if (operation === "move") await adapter.move("A", "Moved");
        if (operation === "remove") await adapter.remove("A");
      });
    await assert.rejects(act, /Document changed during history capture/, operation);
    adapter.history!.captureUnlocked = capture;
    assert.equal(injected, true, operation);
    assert.equal(await adapter.readFile("A/A.md"), edited, operation);
    assert.equal(await adapter.exists("Moved"), false);
  }
});

test("same-value metadata saves capture exact editor bytes with no document writes", async (t) => {
  const h = await fixture(t),
    { adapter, workspaceId } = h;
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
    const send = () => editNode(adapter, "node-alpha", { frontmatter: save.frontmatter });
    const saved = await send();
    assert.ok(saved.version);
    assert.equal(await adapter.history!.read(saved.version), raw, save.method);
    const head = await adapter.history.currentCommit();
    await send();
    assert.equal(await adapter.history.currentCommit(), head, save.method);
    assert.equal(await adapter.readFile("A/A.md"), raw, save.method);
  }
  assert.equal(documentWrites, 0);
  const editable = await readNodeFile(adapter, "node-alpha");
  const changed = await editNode(adapter, "node-alpha", {
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
  test(`pure document reads preserve document and recovery files during pending ${stage}`, async (t) => {
    const h = await fixture(t),
      { adapter } = h;
    const write = adapter.writeFile.bind(adapter),
      move = adapter.move.bind(adapter);
    let legacyPlan: string | undefined;
    const recordPlan = async (file: string, raw: string) => {
      if ([NODE_MOVE_PENDING_PATH, DELETE_PENDING_PATH].includes(file)) legacyPlan = raw;
      return write(file, raw);
    };
    adapter.writeFile = recordPlan;
    if (stage === "corrupt-order") {
      await adapter.writeFile("order.json", "invalid JSON");
    } else if (stage === "move") {
      // Seed the legacy structural record explicitly after the new transaction rolls back.
      adapter.move = async (from, to) => {
        if (from.startsWith("Moved")) throw new Error("injected pending move");
        return move(from, to);
      };
      await assert.rejects(renameNode(h.mount.env, "node-bravo", "Moved"), /injected pending move/);
      adapter.move = move;
      adapter.writeFile = write;
      assert.ok(legacyPlan);
      await fs.writeFile(path.join(h.mount.systemRoot, NODE_MOVE_PENDING_PATH), legacyPlan);
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
          return recordPlan(file, raw);
        };
      }
      await assert.rejects(deleteNode(h.mount.env, "node-bravo"), /injected pending delete/);
      adapter.move = move;
      adapter.writeFile = write;
      assert.ok(legacyPlan);
      await fs.writeFile(path.join(h.mount.systemRoot, DELETE_PENDING_PATH), legacyPlan);
      if (stage !== "delete-before") {
        await fs.mkdir(path.join(h.mount.systemRoot, "temp"), { recursive: true });
        await fs.rename(
          path.join(h.mount.systemRoot, "B"),
          path.join(h.mount.systemRoot, "temp/delete-pending"),
        );
      }
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
    const inspect = () => readNodeFile(adapter, "node-alpha");
    if (stage === "corrupt-order") {
      await assert.rejects(inspect, /requires explicit repair/);
      assert.deepEqual(await snapshot(), before);
      return;
    }
    const result = await inspect();
    assert.equal(result.nodeId, "node-alpha");
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
