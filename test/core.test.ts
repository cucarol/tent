import assert from "node:assert/strict";
import test from "node:test";
import { readdir } from "node:fs/promises";
import { createNode } from "../src/core/ops.js";
import { readNodeForEdit } from "../src/core/node-query.js";
import { writeNodeDocument } from "../src/core/node-document-write.js";
import { serializeFrontmatter } from "../src/core/frontmatter.js";
import { loadTent, nodeNotePath } from "../src/core/tree.js";
import { NodeFs, SystemClock } from "../src/fs/node-fs.js";
import { makeTent } from "./helpers.js";
import { workspaceDocumentPaths } from "../src/core/workspace-revision.js";

test("Node creation rejects unindexable names before writing and allows nested system basenames", async () => {
  const root = await makeTent();
  const fs = new NodeFs(root);
  const env = { fs, clock: new SystemClock(), tentName: "test", tentRoot: root };
  // Initialize persistent lock bookkeeping before comparing product files.
  await fs.withLock("mutation.lock", async () => {});
  const before = await readdir(root, { recursive: true });
  const orderBefore = (await fs.exists("order.json")) ? await fs.readFile("order.json") : null;
  for (const parentPath of ["", "prompt"]) {
    const names = [".gitnotes", ".github", "roles", "cards", "temp", "attachments", ".tent"];
    if (!parentPath)
      names.push(
        "index.md",
        "settings.json",
        "mutation.lock.guard",
        "mutation.lock.guard.pending-token",
      );
    for (const name of names) {
      await assert.rejects(
        createNode(env, { parentPath, name, type: "prompt" }),
        /reserved or excluded/,
      );
    }
  }
  assert.deepEqual(await readdir(root, { recursive: true }), before);
  assert.equal(
    (await fs.exists("order.json")) ? await fs.readFile("order.json") : null,
    orderBefore,
  );
  const id = await createNode(env, { parentPath: "prompt", name: "index.md", type: "prompt" });
  assert.equal((await loadTent(fs)).byId.get(id)?.path, "prompt/index.md");
});

test("Node and revision scans never enter transient mutation lock guard directories", async () => {
  const root = await makeTent();
  const fs = new NodeFs(root);
  const listDir = fs.listDir.bind(fs);
  const guardNames = [
    "mutation.lock.guard",
    "mutation.lock.guard.pending-token",
    "mutation.lock.guard.released-token",
    "mutation.lock.guard.stale-token",
  ];
  fs.listDir = async (dir) => {
    assert.equal(
      guardNames.includes(dir),
      false,
      `Transient guard disappeared before scanning: ${dir}`,
    );
    const entries = await listDir(dir);
    return dir === ""
      ? [...entries, ...guardNames.map((name) => ({ name, isDir: true }))]
      : entries;
  };
  assert.equal((await loadTent(fs)).byId.has("node-p1"), true);
  assert.ok((await workspaceDocumentPaths(fs)).includes("prompt/表达式任务书/表达式任务书.md"));
});

test("Core loads and extends the typed Node document forest", async () => {
  const root = await makeTent();
  const fs = new NodeFs(root);
  const env = { fs, clock: new SystemClock(), tentName: "test", tentRoot: root };
  const before = await loadTent(fs);
  assert.equal(before.byId.get("node-p1")?.type, "prompt");

  const id = await createNode(env, {
    parentPath: "prompt",
    name: "new-context",
    type: "prompt",
  });
  const created = (await loadTent(fs)).byId.get(id)!;
  assert.equal(created.parent?.id, "node-promptzone");
  assert.equal(created.body, "");
  const edit = await readNodeForEdit(fs, id);
  await writeNodeDocument(fs, id, { baseEtag: edit.etag, body: " \n\t" });
  assert.equal((await loadTent(fs)).byId.get(id)?.body, " \n\t");
});

test("Node creation rejects occupied paths without changing identities, descendants or files", async () => {
  const root = await makeTent();
  const fs = new NodeFs(root);
  const env = { fs, clock: new SystemClock(), tentName: "test", tentRoot: root };
  const original = await fs.readFile(nodeNotePath("prompt/表达式任务书"));
  const orderBefore = (await fs.exists("order.json")) ? await fs.readFile("order.json") : null;
  await assert.rejects(
    createNode(env, {
      parentPath: "prompt",
      name: "表达式任务书",
      type: "output",
    }),
    /Node path already exists/,
  );
  assert.equal(await fs.readFile(nodeNotePath("prompt/表达式任务书")), original);
  const after = await loadTent(fs);
  assert.equal(after.byId.get("node-p1")?.type, "prompt");
  assert.equal(after.byId.get("node-p2")?.parent?.id, "node-p1");

  await fs.mkdir("prompt/occupied");
  await fs.writeFile("prompt/occupied/keep.txt", "unrelated material");
  await assert.rejects(
    createNode(env, {
      parentPath: "prompt",
      name: "occupied",
      type: "prompt",
    }),
    /Node path already exists/,
  );
  assert.equal(await fs.readFile("prompt/occupied/keep.txt"), "unrelated material");
  assert.equal(await fs.exists(nodeNotePath("prompt/occupied")), false);
  assert.equal(
    (await fs.exists("order.json")) ? await fs.readFile("order.json") : null,
    orderBefore,
  );
});

test("Node fallback order uses deterministic code-unit tie breakers", async (t) => {
  const root = await makeTent();
  const fs = new NodeFs(root);
  await fs.writeFile(
    nodeNotePath("goal/e\u0301"),
    serializeFrontmatter({ id: "node-order001", type: "goal" }, "# decomposed\n"),
  );
  await fs.writeFile(
    nodeNotePath("goal/é"),
    serializeFrontmatter({ id: "node-order002", type: "goal" }, "# composed\n"),
  );
  // APFS treats the two spellings as one name, so only one directory exists there.
  const stored = (await fs.listDir("goal")).filter((e) => e.name.normalize("NFC") === "é");
  if (stored.length < 2) {
    t.skip("the filesystem stores both spellings under one name");
    return;
  }
  const names = (await loadTent(fs)).byId
    .get("node-goalzone")!
    .children.map((node) => node.name)
    .filter((name) => name === "e\u0301" || name === "é");
  assert.deepEqual(names, ["e\u0301", "é"]);
});
