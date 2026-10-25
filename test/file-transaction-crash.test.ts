import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs/promises";
import nativeFs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { testScratchRoot } from "./scratch.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { TRANSACTION_PATH } from "../src/core/store/file-transaction.js";
import { writeNodeDocument } from "../src/core/graph/node-document-write.js";
import { readNodeForEdit } from "../src/core/read/node-query.js";

const exec = promisify(execFile);
async function fixture(t: TestContext) {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "file-transaction-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  await scaffoldInWorkspace(new NodeFs(workspace), {
    name: "Crash",
    nodes: [
      { name: "A", id: "node-a", type: "prompt", body: "OLD A\n" },
      { name: "B", id: "node-b", type: "prompt", body: "OLD B\n" },
    ],
  });
  const root = path.join(workspace, ".tent"),
    adapter = new NodeFs(root);
  await exec("git", ["-C", root, "init", "--initial-branch=main"], { windowsHide: true });
  await adapter.withLock("mutation.lock", () =>
    adapter.history.captureUnlocked(
      [
        { path: "A/A.md", raw: "---\nid: node-a\ntype: prompt\n---\nOLD A\n" },
        { path: "B/B.md", raw: "---\nid: node-b\ntype: prompt\n---\nOLD B\n" },
      ],
      { operation: "document.capture" },
    ),
  );
  return { workspace, root, adapter, head: await adapter.history.currentCommit() };
}

for (const published of [false, true]) {
  test(`single write ${published ? "published" : "unpublished"} capture failure settles before another read or write on the same adapter`, async (t) => {
    const { adapter, head } = await fixture(t);
    const before = await readNodeForEdit(adapter, "node-a");
    const observe = adapter.history.withPublicationObserver.bind(adapter.history);
    adapter.history.withPublicationObserver = (observer, action) =>
      observe(
        {
          before: async (commit) => {
            await observer.before(commit);
            if (!published) throw new Error("injected publication receipt failure");
          },
          after: async () => {
            throw new Error("injected publication receipt failure");
          },
        },
        action,
      );
    await assert.rejects(
      writeNodeDocument(adapter, "node-a", { baseEtag: before.etag, body: "NEW A\n" }),
      /injected publication receipt failure/,
    );
    adapter.history.withPublicationObserver = observe;
    const saved = await readNodeForEdit(adapter, "node-a");
    const current = await adapter.history.currentCommit();
    assert.equal(saved.raw, await adapter.history.read({ commit: current!, path: "A/A.md" }));
    assert.equal(saved.body, published ? "NEW A\n" : before.body);
    assert.equal(current === head, !published);
    assert.equal(await adapter.exists(TRANSACTION_PATH), false);
    await writeNodeDocument(adapter, "node-a", { baseEtag: saved.etag, body: "NEXT A\n" });
    const next = await readNodeForEdit(adapter, "node-a");
    assert.equal(next.body, "NEXT A\n");
    assert.equal(
      await adapter.history.read({
        commit: (await adapter.history.currentCommit())!,
        path: "A/A.md",
      }),
      next.raw,
    );
  });
}

test("single capture failure preserves external bytes and reports the conflict on the same adapter", async (t) => {
  const { adapter, root, head } = await fixture(t);
  const before = await readNodeForEdit(adapter, "node-a");
  const external = before.raw + "EXTERNAL\n";
  const observe = adapter.history.withPublicationObserver.bind(adapter.history);
  adapter.history.withPublicationObserver = (observer, action) =>
    observe(
      {
        before: async (commit) => {
          await observer.before(commit);
          await fs.writeFile(path.join(root, "A/A.md"), external);
          throw new Error("injected capture failure with external edit");
        },
        after: observer.after,
      },
      action,
    );
  await assert.rejects(
    writeNodeDocument(adapter, "node-a", { baseEtag: before.etag, body: "NEW A\n" }),
    /injected capture failure with external edit/,
  );
  adapter.history.withPublicationObserver = observe;
  assert.equal(await adapter.readFile("A/A.md"), external);
  assert.equal(await adapter.history.currentCommit(), head);
  assert.deepEqual(adapter.recoveryConflicts, ["A/A.md"]);
  assert.equal(await adapter.exists(TRANSACTION_PATH), false);
});

test("a failed recovery retains the capture error and journal until a normal read retries it", async (t) => {
  const { adapter, root, head } = await fixture(t);
  const before = await readNodeForEdit(adapter, "node-a");
  const observe = adapter.history.withPublicationObserver.bind(adapter.history);
  const writeBinary = adapter.writeBinary.bind(adapter);
  adapter.writeBinary = async (file, bytes) => {
    if (file === "A/A.md") throw new Error("injected recovery storage failure");
    return writeBinary(file, bytes);
  };
  adapter.history.withPublicationObserver = (observer, action) =>
    observe(
      {
        before: async (commit) => {
          await observer.before(commit);
          throw new Error("injected original capture failure");
        },
        after: observer.after,
      },
      action,
    );
  await assert.rejects(
    writeNodeDocument(adapter, "node-a", { baseEtag: before.etag, body: "NEW A\n" }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /injected original capture failure/);
      assert.match(error.message, /injected recovery storage failure/);
      return true;
    },
  );
  await fs.access(path.join(root, TRANSACTION_PATH));
  adapter.writeBinary = writeBinary;
  adapter.history.withPublicationObserver = observe;
  assert.equal((await readNodeForEdit(adapter, "node-a")).raw, before.raw);
  assert.equal(await adapter.history.currentCommit(), head);
  assert.equal(await adapter.exists(TRANSACTION_PATH), false);
  await writeNodeDocument(adapter, "node-a", { baseEtag: before.etag, body: "NEXT A\n" });
});
async function crash(workspace: string, cut: string, mode = "write") {
  try {
    await exec(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./helpers/transaction-crash-child.ts", import.meta.url)),
        workspace,
        cut,
        mode,
      ],
      { windowsHide: true, timeout: 60000 },
    );
    assert.fail("writer must terminate without finally");
  } catch (error) {
    assert.equal(
      (error as { code: number }).code,
      77,
      String((error as { stderr?: string }).stderr ?? error),
    );
    assert.equal(JSON.parse((error as { stdout: string }).stdout.trim()).point, cut);
  }
}
async function values(root: string) {
  return Promise.all(
    ["A/A.md", "B/B.md"].map(async (p) =>
      (await fs.readFile(path.join(root, p), "utf8")).split("---\n").at(-1),
    ),
  );
}
for (const cut of [
  "journal-written",
  "journal-synced",
  "journal-renamed",
  "A-written",
  "A-synced",
  "A-renamed",
  "B-renamed",
  "before-publish",
  "published",
  "returned",
]) {
  test(`real Core batch crash at ${cut}: ordinary get settles the whole batch`, async (t) => {
    const { workspace, root, head } = await fixture(t);
    await crash(workspace, cut);
    const result = await runNodeCommand("get", [
      "node-a",
      "--full",
      "--json",
      "--workspace",
      workspace,
    ]);
    assert.equal(result.exitCode, 0, result.stderr);
    const forward = cut === "published" || cut === "returned";
    assert.deepEqual(await values(root), forward ? ["NEW A\n", "NEW B\n"] : ["OLD A\n", "OLD B\n"]);
    assert.equal(await new NodeFs(root).exists(TRANSACTION_PATH), false);
    const current = await new NodeFs(root).history.currentCommit();
    if (!forward) assert.equal(current, head);
    await exec("git", ["-C", root, "fsck", "--no-reflogs"], { windowsHide: true });
  });
}
test("published batch completes a lost final rename and recovery itself can be interrupted", async (t) => {
  const { workspace, root } = await fixture(t);
  await crash(workspace, "published", "undo-B");
  assert.deepEqual(await values(root), ["NEW A\n", "OLD B\n"]);
  await crash(workspace, "B-renamed", "recover");
  const reopened = new NodeFs(root);
  await reopened.ready();
  assert.deepEqual(await values(root), ["NEW A\n", "NEW B\n"]);
  assert.equal(await reopened.exists(TRANSACTION_PATH), false);
});
test("unpublished batch rollback is restartable and preserves external edits in results and brief", async (t) => {
  const { workspace, root } = await fixture(t);
  await crash(workspace, "B-renamed");
  await crash(workspace, "A-renamed", "recover");
  await fs.writeFile(path.join(root, "B/B.md"), "---\nid: node-b\ntype: prompt\n---\nEXTERNAL B\n");
  const reopened = new NodeFs(root);
  await reopened.ready();
  assert.deepEqual(await values(root), ["OLD A\n", "EXTERNAL B\n"]);
  assert.deepEqual(reopened.recoveryConflicts, ["B/B.md"]);
  assert.equal(await reopened.exists(TRANSACTION_PATH), false);
  const brief = await runWorkspaceCommand("brief", ["--workspace", workspace, "--json"]);
  assert.equal(brief.exitCode, 0, brief.stderr);
  assert.deepEqual(JSON.parse(brief.stdout).recoveryConflicts, ["B/B.md"]);
});
test("negative control: suppressing the journal leaves the real mixed batch visible after ordinary opening", async (t) => {
  const { workspace, root } = await fixture(t);
  await crash(workspace, "A-renamed", "no-journal");
  await new NodeFs(root).ready();
  assert.deepEqual(await values(root), ["NEW A\n", "OLD B\n"]);
});

test("recovery preserves an ancestor replaced by an external file and settles the other batch members", async (t) => {
  const { workspace, root } = await fixture(t);
  await crash(workspace, "before-publish", "create");
  const replaced = path.join(root, "New");
  assert.equal(path.dirname(replaced), root);
  await fs.rm(replaced, { recursive: true });
  await fs.writeFile(replaced, "external ancestor replacement\n");
  // POSIX reports ENOTDIR for this real non-directory ancestor. Normalize the
  // same case on Windows, where a missing descendant can instead be ENOENT.
  const lstat = nativeFs.lstat;
  t.mock.method(nativeFs, "lstat", (file: Parameters<typeof lstat>[0], ...args: unknown[]) => {
    if (String(file) === path.join(root, "New/Child"))
      return Promise.reject(Object.assign(new Error("not a directory"), { code: "ENOTDIR" }));
    return (lstat as (...args: unknown[]) => unknown)(file, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const result = await runNodeCommand("get", [
    "node-a",
    "--full",
    "--json",
    "--workspace",
    workspace,
  ]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(await values(root), ["OLD A\n", "OLD B\n"]);
  assert.equal(await fs.readFile(replaced, "utf8"), "external ancestor replacement\n");
  assert.ok(JSON.parse(result.stdout).recoveryConflicts.includes("New/Child/Child.md"));
  assert.equal(
    await fs.access(path.join(root, TRANSACTION_PATH)).then(
      () => true,
      () => false,
    ),
    false,
  );
});

for (const mode of ["single", "create", "move"]) {
  for (const cut of [
    mode === "move" ? "directory-moved" : "A-renamed",
    "before-publish",
    "published",
  ]) {
    test(`${mode} shares the transaction path at ${cut}`, async (t) => {
      const { workspace, root, head } = await fixture(t);
      const attachment = Buffer.from([0, 255, 128, 42]);
      if (mode === "move") await fs.writeFile(path.join(root, "B/asset.bin"), attachment);
      await crash(workspace, cut, mode);
      const result = await runNodeCommand("get", [
        "node-a",
        "--full",
        "--json",
        "--workspace",
        workspace,
      ]);
      assert.equal(result.exitCode, 0, result.stderr);
      const forward = cut === "published",
        reopened = new NodeFs(root);
      assert.equal(await reopened.exists(TRANSACTION_PATH), false);
      if (mode === "move") {
        assert.equal(await reopened.exists("Moved/Moved.md"), forward);
        assert.equal(await reopened.exists("B/B.md"), !forward);
        assert.deepEqual(
          await fs.readFile(path.join(root, forward ? "Moved/asset.bin" : "B/asset.bin")),
          attachment,
        );
      } else {
        assert.deepEqual(
          await values(root),
          forward ? ["NEW A\n", "OLD B\n"] : ["OLD A\n", "OLD B\n"],
        );
        assert.equal(await reopened.exists("New/Child/Child.md"), mode === "create" && forward);
        if (mode === "create") {
          assert.equal(await reopened.exists("New"), forward);
          assert.equal(await reopened.exists("order.json"), forward);
        }
      }
      if (!forward) assert.equal(await reopened.history.currentCommit(), head);
    });
  }
}
