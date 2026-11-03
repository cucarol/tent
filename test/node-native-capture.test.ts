import { openTestFs, removeTestFixture } from "./node-fs.js";
import { testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { initializeFixtureWorkspace } from "./scratch.js";
import { createNode } from "../src/core/graph/ops.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { runHookCommand } from "../src/cli/hook.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/base/frontmatter.js";
import { documentHeader } from "../src/core/graph/node-catalog.js";
import { captureNativeNodeEdits } from "../src/core/graph/node-native-capture.js";
import { ReaderError } from "../src/core/graph/context-reader.js";
import { appendNodeBody } from "../src/core/write/node-lightwrite.js";

for (const writer of ["native save", "locked append"] as const) {
  test(
    `native capture observes a concurrent ${writer} during collection before retaining bytes`,
    {
      // Windows disallows atomic replacement while the old handle is held open.
      skip: writer === "locked append" && process.platform === "win32",
    },
    async (t) => {
      const { workspace, adapter, output } = await fixture(t);
      const file = "需求/结果/结果.md";
      const filename = path.join(workspace, ".tent", file);
      const head = await adapter.history.currentCommit();
      const original = await adapter.readFile(file);
      const open = fs.open.bind(fs);
      let competed = false;
      const mocked = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        if (
          path.resolve(String(args[0])).toLowerCase() !== filename.toLowerCase() ||
          args[1] !== "r" ||
          competed
        )
          return handle;
        return new Proxy(handle, {
          get(target, key) {
            if (key === "read" || key === "readFile")
              return async (...readArgs: unknown[]) => {
                const result = await Reflect.apply(target[key], target, readArgs);
                if (!competed) {
                  assert.ok(
                    key === "read" ? result.bytesRead > 0 : Buffer.byteLength(result) > 0,
                    "the opened handle supplied real bytes before the competing write",
                  );
                  competed = true;
                  if (writer === "locked append")
                    await appendNodeBody(adapter, output, { body: "competing save" });
                  else await fs.writeFile(filename, original + "\ncompeting save\n");
                }
                return result;
              };
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      });
      syncBuiltinESMExports();
      let result;
      try {
        result = await captureNativeNodeEdits(adapter);
      } finally {
        mocked.mock.restore();
        syncBuiltinESMExports();
      }
      assert.equal(competed, true, `a real ${writer} changed the opened file during the scan`);
      assert.deepEqual(result.invalidNodes, []);
      const raw = await adapter.readFile(file);
      assert.equal(raw.split("competing save").length, 2);
      const captured = await adapter.history.currentCommit();
      assert.equal(await adapter.history.read({ commit: captured!, path: file }), raw);
      assert.equal((await adapter.history.changesInRange({ from: head! })).length, 1);
    },
  );
}

async function fixture(t: TestContext) {
  await fs.mkdir(path.resolve(testScratchRoot()), { recursive: true });
  const workspace = await fs.mkdtemp(path.resolve(testScratchRoot(), "native-node-"));
  t.after(() =>
    removeTestFixture(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await initializeFixtureWorkspace(workspace);
  const adapter = openTestFs(path.join(workspace, ".tent"));
  const env = { fs: adapter, clock: { now: () => new Date().toISOString() }, tentName: "Native" };
  await fs.writeFile(path.join(workspace, "input.txt"), "original material");
  const goal = await createNode(env, {
    name: "需求",
    parentPath: "",
    type: "goal",
    body: "Original goal",
    resource: "../../input.txt",
  });
  const output = await createNode(env, {
    name: "结果",
    parentPath: "需求",
    type: "output",
    body: "## Result\nOriginal output",
  });
  const options = { workspace, json: true };
  const parse = (result: { exitCode: number; stdout: string; stderr: string }) => {
    assert.equal(result.exitCode, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  return { workspace, adapter, goal, output, options, parse };
}

for (const failure of ["changed-twice", "storage"] as const) {
  test(`native collection propagates ${failure} without retrying a locked observation`, async (t) => {
    const { adapter } = await fixture(t);
    const file = "需求/结果/结果.md";
    const head = await adapter.history.currentCommit();
    const raw = await adapter.readFile(file);
    const read = adapter.readFile.bind(adapter);
    const header = adapter.readFrontmatterWithFingerprint.bind(adapter);
    const lock = adapter.withLock.bind(adapter);
    let reads = 0,
      locks = 0;
    const error =
      failure === "changed-twice"
        ? new ReaderError("SOURCE_CHANGED", "controlled concurrent change")
        : Object.assign(new Error("controlled storage failure"), { code: "EACCES" });
    adapter.readFrontmatterWithFingerprint = async (path) => {
      if (path === file) {
        reads++;
        throw error;
      }
      return header(path);
    };
    adapter.withLock = (path, action) => {
      locks++;
      return lock(path, action);
    };
    await assert.rejects(captureNativeNodeEdits(adapter), (caught) => caught === error);
    assert.equal(reads, failure === "changed-twice" ? 2 : 1);
    assert.equal(locks, failure === "changed-twice" ? 1 : 0);
    assert.equal(await read(file), raw);
    assert.equal(await adapter.history.currentCommit(), head);
  });
}

test("native capture skips an unchanged lock and rereads bytes and HEAD after acquiring a needed lock", async (t) => {
  const { adapter, output } = await fixture(t);
  const file = "需求/结果/结果.md";
  const original = await adapter.readFile(file);
  const withLock = adapter.withLock.bind(adapter);
  let locks = 0;
  let beforeCapture: (() => Promise<void>) | undefined;
  adapter.withLock = (lock, action) =>
    withLock(lock, async () => {
      locks++;
      await beforeCapture?.();
      return action();
    });
  await captureNativeNodeEdits(adapter);
  assert.equal(locks, 0);
  await adapter.writeFile(file, original + "\nFirst editor");
  const latest = original + "\nSecond editor and a newer retained HEAD";
  let advanced: string | null = null;
  beforeCapture = async () => {
    await adapter.writeFile(file, latest);
    await adapter.history.captureUnlocked([{ path: file, raw: latest }]);
    advanced = await adapter.history.currentCommit();
  };
  const captured = await captureNativeNodeEdits(adapter);
  assert.equal(locks, 1);
  assert.equal(await adapter.history.currentCommit(), advanced);
  assert.equal(captured.catalog?.byId.get(output)?.header, documentHeader(latest));
  await adapter.writeFile(file, latest + "\nThird editor");
  const invalid = latest.replace("type: output", "type: unknown");
  beforeCapture = async () => {
    await adapter.writeFile(file, invalid);
  };
  const rejected = await captureNativeNodeEdits(adapter);
  assert.equal(locks, 2);
  assert.ok(rejected.invalidNodes.some((node) => node.path === `.tent/${file}`));
  assert.equal(await adapter.readFile(file), invalid);
  assert.equal(await adapter.history.currentCommit(), advanced);
});

test("valid native metadata retains exact declarations and opaque provenance values", async (t) => {
  const { adapter } = await fixture(t);
  const document = parseFrontmatter(await adapter.readFile("需求/需求.md"));
  document.data.sources = [{ resource: "../../新材料.txt" }];
  document.data.provenance = ["opaque", { imported: false }];
  const raw = serializeFrontmatter(document.data, document.body, document.keyOrder);
  await adapter.writeFile("需求/需求.md", raw);
  await captureNativeNodeEdits(adapter);
  const head = await adapter.history.currentCommit();
  assert.ok(head);
  assert.equal(await adapter.history.read({ commit: head, path: "需求/需求.md" }), raw);
  assert.equal(await adapter.readFile("需求/需求.md"), raw);
});

for (const malformed of ["yaml", "schema"] as const)
  test(`native ${malformed} errors remain untouched and visible in check`, async (t) => {
    const { adapter, goal, output, options, parse } = await fixture(t);
    const file = "需求/结果/结果.md";
    const previous = await adapter.history.currentCommit();
    const original = await adapter.readFile(file);
    const raw =
      malformed === "yaml"
        ? original.replace("type: output", "type: [")
        : original.replace("type: output", "type: invalid");
    await adapter.writeFile(file, raw);
    const checked = await runWorkspaceCommand("check", [], options);
    assert.equal(checked.exitCode, 1);
    assert.match(checked.stdout, /结果/);
    assert.equal(await adapter.readFile(file), raw);
    assert.equal(await adapter.history.currentCommit(), previous);
    const renamed = await runNodeCommand("rename", [goal, "Moved"], options);
    assert.equal(renamed.exitCode, 1);
    assert.equal(await adapter.readFile(file), raw);
    assert.equal(await adapter.exists("Moved"), false);
    assert.equal(await adapter.history.currentCommit(), previous);
  });

test("an unretained invalid descendant cannot be moved or captured through its valid parent", async (t) => {
  const { adapter, goal, options, parse } = await fixture(t);
  const head = await adapter.history.currentCommit();
  const file = "需求/坏文件/坏文件.md";
  const raw = "---\nid: node-badnative\ntype: invalid\n---\nKeep these bytes";
  await adapter.writeFile(file, raw);
  const checked = await runWorkspaceCommand("check", [], options);
  assert.equal(checked.exitCode, 1);
  assert.match(checked.stdout, /坏文件/);
  assert.equal((await runNodeCommand("rename", [goal, "Moved"], options)).exitCode, 1);
  assert.equal(await adapter.readFile(file), raw);
  assert.equal(await adapter.exists("Moved"), false);
  assert.equal(await adapter.history.currentCommit(), head);
});

test("Node history CLI captures pending native saves and retains both exact observed versions", async (t) => {
  const { adapter, output, options, parse } = await fixture(t);
  const file = "需求/结果/结果.md";
  const before = (await adapter.history.currentCommit())!;
  const first = (await adapter.readFile(file)) + "\nFirst native note.";
  await adapter.writeFile(file, first);
  parse(await runNodeCommand("history", [output], options));
  const firstHead = (await adapter.history.currentCommit())!;
  assert.notEqual(firstHead, before);
  assert.equal(await adapter.history.read({ commit: firstHead, path: file }), first);
  const second = first + "\nSecond native note.";
  await adapter.writeFile(file, second);
  parse(await runNodeCommand("history", [output], options));
  const secondHead = (await adapter.history.currentCommit())!;
  assert.notEqual(secondHead, firstHead);
  assert.equal(await adapter.history.read({ commit: firstHead, path: file }), first);
  assert.equal(await adapter.history.read({ commit: secondHead, path: file }), second);
  assert.equal(await adapter.readFile(file), second);
});

test("Stop captures native Node creation and deletion without rewriting another Node", async (t) => {
  const { workspace, adapter, goal } = await fixture(t);
  const original = await adapter.readFile("需求/需求.md");
  const created =
    "---\nid: node-nativehook\ntype: prompt\nprovenance: untouched\n---\nNative hook Node\n";
  await adapter.writeFile("原生/原生.md", created);
  const stop = async (host: string) => {
    const result = await runHookCommand("stop", ["--host", host], {
      packageRoot: path.resolve("."),
      stdin: JSON.stringify({ hook_event_name: "Stop", cwd: workspace }),
    });
    assert.equal(result.exitCode, 0, result.stderr);
  };
  await stop("codex");
  const addedHead = (await adapter.history.currentCommit())!;
  assert.equal(await adapter.history.read({ commit: addedHead, path: "原生/原生.md" }), created);
  assert.equal(await adapter.readFile("需求/需求.md"), original);
  await fs.rm(path.join(workspace, ".tent/原生"), { recursive: true });
  await stop("claude-code");
  assert.ok((await adapter.history.retainedPaths()).every((file) => file !== "原生/原生.md"));
  assert.equal(await adapter.history.read({ commit: addedHead, path: "原生/原生.md" }), created);
  assert.equal(await adapter.readFile("需求/需求.md"), original);
  assert.ok((await adapter.history.nodeVersions(goal)).length);
});
