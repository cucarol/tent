import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, type TestContext } from "node:test";
import { contentEtag } from "../src/core/etag.js";
import { readOnlyFs } from "../src/core/adapter.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { readNodeForEdit } from "../src/core/node-query.js";
import { incompleteNodeReadEtag } from "../src/core/node-read-basis.js";
import {
  NodeBatchWriteError,
  writeNodesBatch,
  type NodeWriteBatchInput,
} from "../src/core/node-write-batch.js";
import { createNode } from "../src/core/ops.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { testScratchRoot } from "./scratch.js";

async function fixture(t: TestContext) {
  const workspace = await mkdtemp(path.join(testScratchRoot(), "node-write-batch-"));
  t.after(() => rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  await scaffoldInWorkspace(new NodeFs(workspace), { name: "Batch" });
  const root = path.join(workspace, ".tent"),
    fs = new NodeFs(root);
  await promisify(execFile)("git", ["-C", root, "init", "--initial-branch=main"], {
    windowsHide: true,
  });
  const env = { fs, clock: { now: () => "2026-10-04T00:00:00.000Z" }, tentName: "Batch" };
  const id = await createNode(env, {
    name: "Existing",
    parentPath: "",
    type: "output",
    body: "old body\n",
  });
  const existing = await readNodeForEdit(fs, id);
  return { env, fs, root, existing };
}

test("batch creates forward parents and mutual links, updates, and captures once in input order", async (t) => {
  const { env, fs, existing } = await fixture(t);
  const before = await fs.history.currentCommit();
  const lock = fs.withLock.bind(fs),
    capture = fs.history.captureUnlocked.bind(fs.history);
  let locks = 0,
    captures = 0;
  fs.withLock = async (path, action) => {
    locks++;
    return lock(path, action);
  };
  fs.history.captureUnlocked = async (changes, metadata) => {
    captures++;
    return capture(changes, metadata);
  };
  const result = await writeNodesBatch(env, {
    items: [
      {
        op: "create",
        ref: "child",
        parent: "@parent",
        name: "Child",
        type: "prompt",
        body: "[parent](@parent#part)\n[peer][peer]\n\n[peer]: @peer\nCode `@missing`",
        sources: [{ resource: "@peer", label: "peer" }],
      },
      {
        op: "update",
        nodeId: existing.nodeId,
        baseEtag: existing.etag,
        body: "[child](@child)",
        frontmatter: { resource: "@peer" },
      },
      {
        op: "create",
        ref: "peer",
        parent: null,
        name: "Peer",
        type: "output",
        body: "[child](@child)",
        sources: [{ resource: "@child" }],
      },
      { op: "create", ref: "parent", parent: null, name: "Parent", type: "goal" },
    ],
  });
  assert.equal(locks, 1);
  assert.equal(captures, 1);
  assert.deepEqual(
    result.results.map((n) => n.path),
    ["Parent/Child", "Existing", "Peer", "Parent"],
  );
  assert.equal(result.results[1]!.nodeId, existing.nodeId);
  for (const node of result.results) {
    const name = node.path.split("/").at(-1)!;
    assert.equal(node.etag, contentEtag(await fs.readFile(`${node.path}/${name}.md`)));
  }
  const child = parseFrontmatter(await fs.readFile("Parent/Child/Child.md"));
  assert.match(child.body, /\[parent\]\(\.\.\/Parent.md#part\)/);
  assert.match(child.body, /\[peer\]: \.\.\/\.\.\/Peer\/Peer.md/);
  assert.match(child.body, /`@missing`/);
  assert.deepEqual(child.data.sources, [{ resource: "../../Peer/Peer.md", label: "peer" }]);
  const order = JSON.parse(await fs.readFile("order.json"));
  assert.deepEqual(order[result.results[3]!.nodeId], [result.results[0]!.nodeId]);
  const commits = await fs.history.changesInRange({ from: before! });
  assert.equal(commits.length, 1);
  assert.equal(commits[0]!.commit, result.commit);
  assert.equal(commits[0]!.operation, "node.write-many");
  assert.equal(commits[0]!.changes.length, 4);
});

test("raw update rewrites only parsed reference positions and preserves arbitrary metadata/prose", async (t) => {
  const { env, fs, existing } = await fixture(t);
  const raw = serializeFrontmatter(
    {
      ...existing.frontmatter,
      custom: "@missing",
      sources: [{ resource: "@new", label: "@missing" }],
    },
    "Prose @missing\n[created](@new?query#part)\n`[ignored](@missing)`",
  );
  await writeNodesBatch(env, {
    items: [
      { op: "update", nodeId: existing.nodeId, baseEtag: existing.etag, raw },
      { op: "create", ref: "new", parent: existing.nodeId, name: "New", type: "output" },
    ],
  });
  const next = parseFrontmatter(await fs.readFile("Existing/Existing.md"));
  assert.equal(next.data.custom, "@missing");
  assert.deepEqual(next.data.sources, [{ resource: "./New/New.md", label: "@missing" }]);
  assert.match(next.body, /\[created\]\(\.\/New\/New.md\?query#part\)/);
  assert.match(next.body, /Prose @missing/);
});

for (const failure of [
  "validation",
  "cycle",
  "unknown-parent",
  "unknown-link",
  "unknown-resource",
  "duplicate-ref",
  "duplicate-path",
  "duplicate-update",
  "stale",
  "incomplete-body",
  "incomplete-metadata",
] as const) {
  test(`batch ${failure} preflight leaves files, directories, order and Git untouched`, async (t) => {
    const { env, fs, existing } = await fixture(t);
    const initialOrder = await fs.readFile("order.json"),
      initialHead = await fs.history.currentCommit();
    const create: NodeWriteBatchInput["items"][number] = {
      op: "create",
      ref: "new",
      parent: null,
      name: "New",
      type: "output",
    };
    const update: NodeWriteBatchInput["items"][number] = {
      op: "update",
      nodeId: existing.nodeId,
      baseEtag: existing.etag,
      body: "next",
    };
    let items: NodeWriteBatchInput["items"] = [create, update];
    if (failure === "validation")
      items.push({
        op: "create",
        ref: "invalid",
        parent: null,
        name: "Invalid",
        type: "output",
        sources: [{ resource: "" }],
      });
    if (failure === "cycle") {
      create.parent = "@later";
      items.push({ op: "create", ref: "later", parent: "@new", name: "Later", type: "goal" });
    }
    if (failure === "unknown-parent") create.parent = "@missing";
    if (failure === "unknown-link") create.body = "[missing](@missing)";
    if (failure === "unknown-resource") create.resource = "@missing";
    if (failure === "duplicate-ref") items.push({ ...create, name: "Other" });
    if (failure === "duplicate-path") items.push({ ...create, ref: "other" });
    if (failure === "duplicate-update") items.push({ ...update });
    if (failure === "stale") update.baseEtag = "stale";
    if (failure.startsWith("incomplete")) update.baseEtag = incompleteNodeReadEtag(existing.etag);
    if (failure === "incomplete-metadata") {
      delete update.body;
      update.frontmatter = { description: "next" };
    }
    const write = fs.writeFile.bind(fs),
      mkdir = fs.mkdir.bind(fs);
    let writes = 0;
    fs.writeFile = async (...args) => {
      writes++;
      return write(...args);
    };
    fs.mkdir = async (...args) => {
      writes++;
      return mkdir(...args);
    };
    await assert.rejects(writeNodesBatch(env, { items }));
    assert.equal(writes, 0);
    assert.equal(await fs.exists("New"), false);
    assert.equal(await fs.readFile("Existing/Existing.md"), existing.raw);
    assert.equal(await fs.readFile("order.json"), initialOrder);
    assert.equal(await fs.history.currentCommit(), initialHead);
  });
}

for (const failure of ["document", "order", "capture", "git-lock"] as const) {
  test(`batch restores exact preimages on ${failure} failure`, async (t) => {
    const { env, fs, root, existing } = await fixture(t);
    const initialOrder = await fs.readFile("order.json"),
      initialHead = await fs.history.currentCommit();
    const write = fs.writeFile.bind(fs);
    let failed = false;
    fs.writeFile = async (file, raw) => {
      await write(file, raw);
      if (
        !failed &&
        ((failure === "document" && file === "New/Child/Child.md") ||
          (failure === "order" && file === "order.json"))
      ) {
        failed = true;
        throw new Error("injected write failure after save");
      }
    };
    if (failure === "capture")
      fs.history.captureUnlocked = async () => {
        throw new Error("injected capture failure");
      };
    if (failure === "git-lock") {
      const head = (await readFile(path.join(root, ".git/HEAD"), "utf8")).trim();
      const ref = head.startsWith("ref: ") ? head.slice(5) : "HEAD";
      await mkdir(path.dirname(path.join(root, ".git", ref)), { recursive: true });
      await writeFile(path.join(root, ".git", `${ref}.lock`), "locked");
    }
    await assert.rejects(
      writeNodesBatch(env, {
        items: [
          { op: "update", nodeId: existing.nodeId, baseEtag: existing.etag, body: "next" },
          { op: "create", ref: "child", parent: "@new", name: "Child", type: "output" },
          { op: "create", ref: "new", parent: null, name: "New", type: "goal" },
        ],
      }),
      /failure|HEAD changed/,
    );
    assert.equal(await fs.readFile("Existing/Existing.md"), existing.raw);
    assert.equal(await fs.readFile("order.json"), initialOrder);
    assert.equal(await fs.exists("New"), false);
    assert.equal(await fs.history.currentCommit(), initialHead);
  });
}

test("batch rollback restores absent order sidecar and no-op update retains exact bytes", async (t) => {
  const { env, fs, existing } = await fixture(t);
  await fs.remove("order.json");
  const before = await fs.history.currentCommit();
  const noop = await writeNodesBatch(env, {
    items: [
      { op: "update", nodeId: existing.nodeId, baseEtag: existing.etag, body: existing.body },
    ],
  });
  assert.equal(noop.results[0]!.etag, existing.etag);
  assert.equal(await fs.history.currentCommit(), before);
  assert.equal(await fs.exists("order.json"), false);
  fs.history.captureUnlocked = async () => {
    throw new Error("capture failure");
  };
  await assert.rejects(
    writeNodesBatch(env, {
      items: [{ op: "create", ref: "new", parent: null, name: "New", type: "output" }],
    }),
    /capture failure/,
  );
  assert.equal(await fs.exists("order.json"), false);
  assert.equal(await fs.exists("New"), false);
});

test("batch rollback preserves external edits and reports exact conflicting paths", async (t) => {
  const { env, fs, existing } = await fixture(t);
  const before = await fs.history.currentCommit();
  const write = fs.writeFile.bind(fs);
  const external = serializeFrontmatter(existing.frontmatter, "external edit");
  fs.history.captureUnlocked = async () => {
    await write("Existing/Existing.md", external);
    await write("New/Child/Child.md", "external created-document edit");
    await write("order.json", '{"external":[]}\n');
    throw new Error("capture failed");
  };
  await assert.rejects(
    writeNodesBatch(env, {
      items: [
        { op: "update", nodeId: existing.nodeId, baseEtag: existing.etag, body: "next" },
        { op: "create", ref: "new", name: "New", type: "goal" },
        { op: "create", ref: "child", parent: "@new", name: "Child", type: "output" },
      ],
    }),
    (error) => {
      assert.ok(error instanceof NodeBatchWriteError);
      assert.ok(error.details.conflicts.includes("Existing/Existing.md"));
      assert.ok(error.details.conflicts.includes("New/Child/Child.md"));
      assert.ok(error.details.conflicts.includes("order.json"));
      assert.match(error.message, /Existing\/Existing.md/);
      return true;
    },
  );
  assert.equal(await fs.readFile("Existing/Existing.md"), external);
  assert.equal(await fs.readFile("New/Child/Child.md"), "external created-document edit");
  assert.equal(await fs.readFile("order.json"), '{"external":[]}\n');
  assert.equal(await fs.history.currentCommit(), before);
});

test("batch detects a new document appearing after directory creation and preserves its external bytes", async (t) => {
  const { env, fs, existing } = await fixture(t);
  const before = await fs.history.currentCommit(),
    beforeOrder = await fs.readFile("order.json");
  const write = fs.writeFile.bind(fs);
  const external = serializeFrontmatter(
    { id: "node-external", type: "output" },
    "external new document",
  );
  let createWrites = 0;
  fs.writeFile = async (file, raw) => {
    if (file === "New/New.md") {
      createWrites++;
      throw new Error("new document must not be overwritten");
    }
    await write(file, raw);
    if (file === "Existing/Existing.md" && raw !== existing.raw)
      await write("New/New.md", external);
  };
  await assert.rejects(
    writeNodesBatch(env, {
      items: [
        { op: "update", nodeId: existing.nodeId, baseEtag: existing.etag, body: "next" },
        { op: "create", ref: "new", name: "New", type: "output" },
      ],
    }),
    (error) => {
      assert.ok(error instanceof NodeBatchWriteError);
      assert.ok(error.details.conflicts.includes("New/New.md"));
      assert.match(String(error.causes[0]), /Node document appeared/);
      return true;
    },
  );
  assert.equal(createWrites, 0);
  assert.equal(await fs.readFile("Existing/Existing.md"), existing.raw);
  assert.equal(await fs.readFile("New/New.md"), external);
  assert.equal(await fs.readFile("order.json"), beforeOrder);
  assert.equal(await fs.history.currentCommit(), before);
});

for (const body of [
  "[unknown](@missing/attachments/file)",
  "[unknown][ref]\n\n[ref]: @missing/attachments/file",
]) {
  test(`batch rejects unknown local references in canonical rewrite positions: ${body}`, async (t) => {
    const { env, fs, existing } = await fixture(t);
    const before = await fs.history.currentCommit(),
      beforeOrder = await fs.readFile("order.json");
    await assert.rejects(
      writeNodesBatch(env, {
        items: [
          { op: "update", nodeId: existing.nodeId, baseEtag: existing.etag, body: "next" },
          { op: "create", ref: "new", name: "New", type: "output", body },
        ],
      }),
      /Unknown batch ref/,
    );
    assert.equal(await fs.exists("New"), false);
    assert.equal(await fs.readFile("Existing/Existing.md"), existing.raw);
    assert.equal(await fs.readFile("order.json"), beforeOrder);
    assert.equal(await fs.history.currentCommit(), before);
  });
}

test("batch follows shared canonical rules for images and unused definitions", async (t) => {
  const { env, fs, existing } = await fixture(t);
  const body =
    "![image](@missing)\n![image][image-ref]\n\n[image-ref]: @missing\n[unused]: @missing";
  await writeNodesBatch(env, {
    items: [{ op: "update", nodeId: existing.nodeId, baseEtag: existing.etag, body }],
  });
  assert.equal(parseFrontmatter(await fs.readFile("Existing/Existing.md")).body, body);
});

test("batch rollback removes only known documents and preserves hidden external files", async (t) => {
  const { env, fs, existing } = await fixture(t);
  const before = await fs.history.currentCommit(),
    beforeOrder = await fs.readFile("order.json");
  const write = fs.writeFile.bind(fs);
  fs.history.captureUnlocked = async () => {
    await write("New/.gitkeep", "external hidden file");
    await write("New/Child/.gitignore", "external hidden ignore rules");
    throw new Error("capture failed");
  };
  await assert.rejects(
    writeNodesBatch(env, {
      items: [
        { op: "update", nodeId: existing.nodeId, baseEtag: existing.etag, body: "next" },
        { op: "create", ref: "new", name: "New", type: "goal" },
        { op: "create", ref: "child", parent: "@new", name: "Child", type: "output" },
      ],
    }),
    (error) => {
      assert.ok(error instanceof NodeBatchWriteError);
      assert.ok(error.details.conflicts.includes("New"));
      assert.ok(error.details.conflicts.includes("New/Child"));
      assert.match(String(error.causes[0]), /capture failed/);
      return true;
    },
  );
  assert.equal(await fs.readFile("New/.gitkeep"), "external hidden file");
  assert.equal(await fs.readFile("New/Child/.gitignore"), "external hidden ignore rules");
  assert.equal(await fs.exists("New/New.md"), false);
  assert.equal(await fs.exists("New/Child/Child.md"), false);
  assert.equal(await fs.readFile("Existing/Existing.md"), existing.raw);
  assert.equal(await fs.readFile("order.json"), beforeOrder);
  assert.equal(await fs.history.currentCommit(), before);
  assert.throws(() => readOnlyFs(fs).removeEmptyDir("New"), /never mutate/);
});

test("batch reports Windows EEXIST empty-directory cleanup as a conflict and retains the save failure", async (t) => {
  const { env, fs, existing } = await fixture(t);
  fs.history.captureUnlocked = async () => {
    throw new Error("original capture failure");
  };
  fs.removeEmptyDir = async () => {
    throw Object.assign(new Error("directory contains external entries"), { code: "EEXIST" });
  };
  await assert.rejects(
    writeNodesBatch(env, {
      items: [
        { op: "update", nodeId: existing.nodeId, baseEtag: existing.etag, body: "next" },
        { op: "create", ref: "new", name: "New", type: "output" },
      ],
    }),
    (error) => {
      assert.ok(error instanceof NodeBatchWriteError);
      assert.deepEqual(error.details.conflicts, ["New"]);
      assert.match(String(error.causes[0]), /original capture failure/);
      return true;
    },
  );
  assert.equal(await fs.readFile("Existing/Existing.md"), existing.raw);
  assert.equal(await fs.exists("New/New.md"), false);
  assert.equal(await fs.exists("New"), true);
});
