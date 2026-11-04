import { openTestFs, removeTestFixture } from "./node-fs.js";
import { DatabaseSync } from "../src/fs/sqlite-runtime.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { parseFrontmatter } from "../src/core/base/frontmatter.js";
import { type NodeWriteBatchInput } from "../src/core/write/node-write-batch.js";
import { createNode } from "../src/core/graph/ops.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { initializeFixtureHistory, testScratchRoot } from "./scratch.js";
import { readNodeFile, saveNodesBatch } from "./node-edit.js";

async function fixture(t: TestContext) {
  const workspace = await mkdtemp(path.join(testScratchRoot(), "node-write-batch-"));
  t.after(async () => {
    await fs.close();
    await removeTestFixture(workspace, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 200,
    });
  });
  await scaffoldInWorkspace(workspace, { name: "Batch" });
  const root = path.join(workspace, ".tent"),
    fs = openTestFs(root);
  await initializeFixtureHistory(root);

  const env = { fs, clock: { now: () => "2026-10-04T00:00:00.000Z" }, tentName: "Batch" };
  const id = await createNode(env, {
    name: "Existing",
    parentPath: "",
    type: "output",
    body: "old body\n",
  });
  const existing = await readNodeFile(fs, id);
  return { env, fs, root, existing };
}

test("batch creates forward parents and mutual links and captures once in input order", async (t) => {
  const { env, fs, existing } = await fixture(t);
  const before = await fs.history.currentCommit();
  const lock = fs.withLock.bind(fs),
    capture = fs.history.captureUnlocked.bind(fs.history);
  let locks = 0,
    captures = 0;
  fs.withLock = async (action) => {
    locks++;
    return lock(action);
  };
  fs.history.captureUnlocked = async (changes, metadata) => {
    captures++;
    return capture(changes, metadata);
  };
  const result = await saveNodesBatch(env, {
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
        op: "create",
        ref: "peer",
        parent: existing.nodeId,
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
    ["Parent/Child", "Existing/Peer", "Parent"],
  );
  for (const node of result.results) {
    const name = node.path.split("/").at(-1)!;
    const raw = await fs.readFile(`${node.path}/${name}.md`);
    assert.equal("generated" in parseFrontmatter(raw).data, false);
  }
  const child = parseFrontmatter(await fs.readFile("Parent/Child/Child.md"));
  assert.match(child.body, /\[parent\]\(\.\.\/Parent.md#part\)/);
  assert.match(child.body, /\[peer\]: \.\.\/\.\.\/Existing\/Peer\/Peer.md/);
  assert.match(child.body, /`@missing`/);
  assert.deepEqual(child.data.sources, [
    { resource: "../../Existing/Peer/Peer.md", label: "peer" },
  ]);
  const order = JSON.parse(await fs.readFile("order.json"));
  assert.deepEqual(order[result.results[2]!.nodeId], [result.results[0]!.nodeId]);
  assert.deepEqual(order[existing.nodeId], [result.results[1]!.nodeId]);
  const commits = await fs.history.changesInRange({ from: before! });
  assert.equal(commits.length, 1);
  assert.equal(commits[0]!.commit, result.commit);
  assert.equal(commits[0]!.operation, "node.write-many");
  assert.equal(commits[0]!.changes.length, 3);
});

for (const failure of [
  "validation",
  "cycle",
  "unknown-parent",
  "unknown-link",
  "unknown-resource",
  "duplicate-ref",
  "duplicate-path",
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
    const items: NodeWriteBatchInput["items"] = [create];
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
    await assert.rejects(saveNodesBatch(env, { items }));
    assert.equal(writes, 0);
    assert.equal(await fs.exists("New"), false);
    assert.equal(await fs.readFile("Existing/Existing.md"), existing.raw);
    assert.equal(await fs.readFile("order.json"), initialOrder);
    assert.equal(await fs.history.currentCommit(), initialHead);
  });
}

for (const failure of ["document", "order", "capture", "sqlite-busy"] as const) {
  test(`batch restores exact preimages on ${failure} failure`, async (t) => {
    const { env, fs, root } = await fixture(t);
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
    let blocker: DatabaseSync | undefined;
    if (failure === "sqlite-busy") {
      blocker = new DatabaseSync(path.join(root, ".git/history.sqlite"));
      blocker.exec("BEGIN IMMEDIATE");
    }
    try {
      await assert.rejects(
        saveNodesBatch(env, {
          items: [
            { op: "create", ref: "child", parent: "@new", name: "Child", type: "output" },
            { op: "create", ref: "new", parent: null, name: "New", type: "goal" },
          ],
        }),
        /failure|locked/,
      );
    } finally {
      if (blocker) {
        blocker.exec("ROLLBACK");
        blocker.close();
      }
    }
    assert.equal(await fs.readFile("order.json"), initialOrder);
    assert.equal(await fs.exists("New"), false);
    assert.equal(await fs.history.currentCommit(), initialHead);
  });
}

test("batch rollback restores an absent order sidecar", async (t) => {
  const { env, fs } = await fixture(t);
  await fs.remove("order.json");
  fs.history.captureUnlocked = async () => {
    throw new Error("capture failure");
  };
  await assert.rejects(
    saveNodesBatch(env, {
      items: [{ op: "create", ref: "new", parent: null, name: "New", type: "output" }],
    }),
    /capture failure/,
  );
  assert.equal(await fs.exists("order.json"), false);
  assert.equal(await fs.exists("New"), false);
});

test("batch rollback preserves external edits and reports exact conflicting paths", async (t) => {
  const { env, fs, root } = await fixture(t);
  const before = await fs.history.currentCommit();
  const write = (file: string, raw: string) => writeFile(path.join(root, file), raw);
  fs.history.captureUnlocked = async () => {
    await write("New/Child/Child.md", "external created-document edit");
    await write("order.json", '{"external":[]}\n');
    throw new Error("capture failed");
  };
  await assert.rejects(
    saveNodesBatch(env, {
      items: [
        { op: "create", ref: "new", name: "New", type: "goal" },
        { op: "create", ref: "child", parent: "@new", name: "Child", type: "output" },
      ],
    }),
    /capture failed/,
  );
  assert.ok(fs.recoveryConflicts.includes("New/Child/Child.md"));
  assert.ok(fs.recoveryConflicts.includes("order.json"));
  assert.equal(await fs.readFile("New/Child/Child.md"), "external created-document edit");
  assert.equal(await fs.readFile("order.json"), '{"external":[]}\n');
  assert.equal(await fs.history.currentCommit(), before);
});

for (const body of [
  "[unknown](@missing/attachments/file)",
  "[unknown][ref]\n\n[ref]: @missing/attachments/file",
]) {
  test(`batch rejects unknown local references in canonical rewrite positions: ${body}`, async (t) => {
    const { env, fs } = await fixture(t);
    const before = await fs.history.currentCommit(),
      beforeOrder = await fs.readFile("order.json");
    await assert.rejects(
      saveNodesBatch(env, {
        items: [{ op: "create", ref: "new", name: "New", type: "output", body }],
      }),
      /Unknown batch ref/,
    );
    assert.equal(await fs.exists("New"), false);
    assert.equal(await fs.readFile("order.json"), beforeOrder);
    assert.equal(await fs.history.currentCommit(), before);
  });
}

test("batch follows shared canonical rules for images and unused definitions", async (t) => {
  const { env, fs } = await fixture(t);
  const body =
    "![image](@missing)\n![image][image-ref]\n\n[image-ref]: @missing\n[unused]: @missing";
  await saveNodesBatch(env, {
    items: [{ op: "create", ref: "new", name: "New", type: "output", body }],
  });
  assert.equal(parseFrontmatter(await fs.readFile("New/New.md")).body, body);
});

test("batch rollback removes only known documents and preserves hidden external files", async (t) => {
  const { env, fs, root } = await fixture(t);
  const before = await fs.history.currentCommit(),
    beforeOrder = await fs.readFile("order.json");
  const write = (file: string, raw: string) => writeFile(path.join(root, file), raw);
  fs.history.captureUnlocked = async () => {
    await write("New/.gitkeep", "external hidden file");
    await write("New/Child/.gitignore", "external hidden ignore rules");
    throw new Error("capture failed");
  };
  await assert.rejects(
    saveNodesBatch(env, {
      items: [
        { op: "create", ref: "new", name: "New", type: "goal" },
        { op: "create", ref: "child", parent: "@new", name: "Child", type: "output" },
      ],
    }),
    /capture failed/,
  );
  assert.ok(fs.recoveryConflicts.includes("New"));
  assert.ok(fs.recoveryConflicts.includes("New/Child"));
  assert.equal(await fs.readFile("New/.gitkeep"), "external hidden file");
  assert.equal(await fs.readFile("New/Child/.gitignore"), "external hidden ignore rules");
  assert.equal(await fs.exists("New/New.md"), false);
  assert.equal(await fs.exists("New/Child/Child.md"), false);
  assert.equal(await fs.readFile("order.json"), beforeOrder);
  assert.equal(await fs.history.currentCommit(), before);
});

test("batch reports Windows EEXIST empty-directory cleanup as a conflict and retains the save failure", async (t) => {
  const { env, fs } = await fixture(t);
  fs.history.captureUnlocked = async () => {
    throw new Error("original capture failure");
  };
  fs.removeEmptyDir = async () => {
    throw Object.assign(new Error("directory contains external entries"), { code: "EEXIST" });
  };
  await assert.rejects(
    saveNodesBatch(env, {
      items: [{ op: "create", ref: "new", name: "New", type: "output" }],
    }),
    /original capture failure/,
  );
  assert.deepEqual(fs.recoveryConflicts, ["New"]);
  assert.equal(await fs.exists("New/New.md"), false);
  assert.equal(await fs.exists("New"), true);
});

test("batch retains the original capture error when recovery also fails, then ordinary read restores the group", async (t) => {
  const { env, fs, root } = await fixture(t);
  const before = await fs.history.currentCommit(),
    beforeOrder = await fs.readFile("order.json");
  const capture = fs.history.captureUnlocked.bind(fs.history),
    writeBinary = fs.writeBinary.bind(fs);
  fs.history.captureUnlocked = async (changes, metadata) => {
    if (metadata?.operation === "node.write-many")
      throw new Error("original batch capture failure");
    return capture(changes, metadata);
  };
  fs.writeBinary = async (file, bytes) => {
    if (file === "order.json") throw new Error("batch recovery storage failure");
    return writeBinary(file, bytes);
  };
  await assert.rejects(
    saveNodesBatch(env, {
      items: [{ op: "create", ref: "new", name: "New", type: "output" }],
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /original batch capture failure/);
      assert.match(error.message, /batch recovery storage failure/);
      return true;
    },
  );
  assert.ok(await readFile(path.join(root, ".git/tent-transaction.json"), "utf8"));
  fs.history.captureUnlocked = capture;
  fs.writeBinary = writeBinary;
  assert.equal(await fs.exists("New"), false);
  assert.equal(await fs.readFile("order.json"), beforeOrder);
  assert.equal(await fs.history.currentCommit(), before);
  assert.equal(await fs.exists(".git/tent-transaction.json"), false);
  await saveNodesBatch(env, {
    items: [{ op: "create", ref: "new", name: "New", type: "output", body: "retry" }],
  });
  assert.equal(parseFrontmatter(await fs.readFile("New/New.md")).body, "retry");
});

test("a failed batch save keeps the original error", async (t) => {
  const { env, fs } = await fixture(t);
  const failure = new Error("batch write failure");
  const write = fs.writeFile.bind(fs);
  fs.writeFile = async (file, raw) => {
    if (file === "New/New.md") throw failure;
    await write(file, raw);
  };
  await assert.rejects(
    saveNodesBatch(env, {
      items: [{ op: "create", ref: "new", name: "New", type: "output" }],
    }),
    (error) => error === failure,
  );
  assert.equal(await fs.exists("New"), false);
});
