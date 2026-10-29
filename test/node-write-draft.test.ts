import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadNodeCatalog } from "../src/core/graph/node-catalog.js";
import { renameNode } from "../src/core/graph/ops.js";
import { readNodeForEdit } from "../src/core/read/node-query.js";
import { writeNodeDocument } from "../src/core/graph/node-document-write.js";
import { test, type TestContext } from "node:test";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { parseFrontmatter } from "../src/core/base/frontmatter.js";
import { checkWorkspaceModules } from "../src/core/check/workspace-module-map.js";
import { writeNodesBatch, type NodeWriteBatchInput } from "../src/core/write/node-write-batch.js";
import { writeNodesDraft } from "../src/core/write/node-write-draft.js";
import { openNodeDraft } from "../src/fs/node-draft-consumption.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { initializeFixtureHistory, testScratchRoot } from "./scratch.js";

async function fixture(t: TestContext, items: NodeWriteBatchInput["items"]) {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "node-write-draft-"));
  t.after(() =>
    removeTestFixture(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await scaffoldInWorkspace(openTestFs(workspace), { name: "Draft" });
  const root = path.join(workspace, ".tent");
  await initializeFixtureHistory(root);
  const adapter = openTestFs(root);
  const filename = path.join(workspace, "draft.json");
  const report = path.join(workspace, "draft.report.json");
  await fs.writeFile(filename, JSON.stringify({ items }, null, 2));
  await fs.writeFile(report, "complete scan snapshot\n");
  const env = { fs: adapter, clock: { now: () => "2026-10-30T00:00:00.000Z" }, tentName: "Draft" };
  const save = async () => {
    const draft = await openNodeDraft(filename, root);
    return writeNodesDraft(env, draft.input, draft.store);
  };
  return { workspace, root, adapter, filename, report, env, save };
}

test("CLI saves two independent draft batches, carries real identities and materials, and leaves partial map gaps visible", async (t) => {
  const f = await fixture(t, [
    { op: "create", ref: "parent", name: "Project", type: "goal", body: "Project goal" },
    {
      op: "create",
      ref: "alpha",
      parent: "@parent",
      name: "Alpha",
      type: "goal",
      body: "Alpha responsibility",
      sources: [{ resource: "src/alpha/", track: "structure" }],
    },
    {
      op: "create",
      ref: "beta",
      parent: "@parent",
      name: "Beta",
      type: "goal",
      body: "",
      sources: [
        { resource: "src/beta/", track: "structure" },
        { resource: "@alpha", label: "@alpha" },
      ],
    },
    {
      op: "create",
      ref: "rule",
      parent: "@beta",
      name: "Rule",
      type: "prompt",
      body: "",
      resource: "@alpha",
      sources: [{ resource: "@parent" }],
    },
  ]);
  for (const name of ["alpha", "beta"]) {
    await fs.mkdir(path.join(f.workspace, "src", name), { recursive: true });
    await fs.writeFile(path.join(f.workspace, "src", name, "index.ts"), "export {};\n");
  }
  const repository = {
    head: null,
    trackedFiles: ["src/alpha/index.ts", "src/beta/index.ts"],
    commits: [],
    sources: { files: [], errors: [] },
  };
  const first = await runNodeCommand("write-many", ["--draft", "draft.json", "--json"], {
    workspace: f.workspace,
  });
  assert.equal(first.exitCode, 0, first.stderr);
  const firstResults = JSON.parse(first.stdout).results;
  assert.equal(firstResults.length, 2);
  const [parent, alpha] = firstResults;
  const remaining = JSON.parse(await fs.readFile(f.filename, "utf8"));
  assert.equal(remaining.items.length, 2);
  assert.equal(remaining.items[0].parent, parent.nodeId);
  assert.equal(remaining.items[0].sources[1].resource, alpha.nodeId);
  assert.equal(remaining.items[0].sources[1].label, "@alpha");
  assert.equal(remaining.items[1].resource, alpha.nodeId);
  assert.equal(remaining.items[1].sources[0].resource, parent.nodeId);
  assert.equal(await fs.readFile(f.report, "utf8"), "complete scan snapshot\n");
  const partial = await checkWorkspaceModules(f.adapter, f.workspace, repository);
  assert.ok(
    partial.issues.some(
      (issue) =>
        issue.code === "map.uncovered" &&
        Array.isArray(issue.facts.files) &&
        issue.facts.files.includes("src/beta/index.ts"),
    ),
  );
  const idle = await runNodeCommand("write-many", ["--draft", "draft.json", "--json"], {
    workspace: f.workspace,
  });
  assert.equal(idle.exitCode, 0, idle.stderr);
  assert.deepEqual(JSON.parse(idle.stdout).results, []);
  remaining.items[0].body = `Beta responsibility; [alpha](${alpha.nodeId}#part)`;
  remaining.items[1].body = `Rule [goal](${parent.nodeId}) and [alpha](${alpha.nodeId})`;
  remaining.items[1].sources.push({ resource: "@missing" });
  await fs.writeFile(f.filename, JSON.stringify(remaining));
  const failedInput = await fs.readFile(f.filename, "utf8");
  const firstHead = await f.adapter.history.currentCommit();
  const failed = await runNodeCommand("write-many", ["--draft", "draft.json", "--json"], {
    workspace: f.workspace,
  });
  assert.equal(failed.exitCode, 1);
  assert.match(failed.stderr, /Unknown batch ref/);
  assert.equal(await f.adapter.exists("Project/Alpha/Alpha.md"), true);
  assert.equal(await f.adapter.exists("Project/Beta"), false);
  assert.equal(await f.adapter.history.currentCommit(), firstHead);
  const failedDraft = JSON.parse(await fs.readFile(f.filename, "utf8"));
  assert.deepEqual(
    failedDraft.items.map(({ id, ...item }: { id?: string }) => item),
    JSON.parse(failedInput).items,
  );
  assert.ok(failedDraft.items.every((item: { id: string }) => /^node-/.test(item.id)));
  remaining.items = failedDraft.items;
  remaining.items[1].sources.pop();
  await fs.writeFile(f.filename, JSON.stringify(remaining));
  const second = await runNodeCommand("write-many", ["--draft", "draft.json", "--json"], {
    workspace: f.workspace,
  });
  assert.equal(second.exitCode, 0, second.stderr);
  assert.deepEqual(
    JSON.parse(second.stdout).results.map((item: { path: string }) => item.path),
    [".tent/Project/Beta/Beta.md", ".tent/Project/Beta/Rule/Rule.md"],
  );
  const beta = parseFrontmatter(await f.adapter.readFile("Project/Beta/Beta.md"));
  assert.match(beta.body, /\[alpha\]\(\.\.\/Alpha\/Alpha.md#part\)/);
  assert.equal((beta.data.sources as { resource: string }[])[0].resource, "../../../src/beta/");
  const rule = parseFrontmatter(await f.adapter.readFile("Project/Beta/Rule/Rule.md"));
  assert.equal(rule.data.resource, "../../Alpha/Alpha.md");
  assert.equal(
    await fs.stat(f.filename).then(
      () => true,
      () => false,
    ),
    false,
  );
  assert.equal(
    await fs.stat(f.report).then(
      () => true,
      () => false,
    ),
    false,
  );
  assert.deepEqual((await checkWorkspaceModules(f.adapter, f.workspace, repository)).issues, []);
  const third = await runNodeCommand("write-many", ["--draft", "draft.json", "--json"], {
    workspace: f.workspace,
  });
  assert.equal(third.exitCode, 1);
  assert.match(third.stderr, /Draft file not found/);
});

test("one staged save uses one mutation lock and capture for forward parents and mutual references", async (t) => {
  const f = await fixture(t, [
    {
      op: "create",
      ref: "child",
      name: "Child",
      parent: "@parent",
      type: "prompt",
      body: "[parent](@parent)",
      sources: [{ resource: "@parent" }],
    },
    { op: "create", ref: "parent", name: "Parent", type: "goal", body: "[child](@child)" },
  ]);
  const lock = f.adapter.withLock.bind(f.adapter),
    capture = f.adapter.history.captureUnlocked.bind(f.adapter.history);
  let locks = 0,
    captures = 0;
  f.adapter.withLock = (...args) => {
    locks++;
    return lock(...args);
  };
  f.adapter.history.captureUnlocked = (...args) => {
    captures++;
    return capture(...args);
  };
  const result = await f.save();
  assert.deepEqual(
    result.results.map((item) => item.path),
    ["Parent/Child", "Parent"],
  );
  assert.equal(locks, 1);
  assert.equal(captures, 1);
  assert.match(
    parseFrontmatter(await f.adapter.readFile("Parent/Parent.md")).body,
    /\[child\]\(\.\/Child\/Child.md\)/,
  );
});

test("written child with blank parent names the prerequisite and saves nothing", async (t) => {
  const f = await fixture(t, [
    { op: "create", ref: "parent", name: "Parent", type: "goal", body: "  \n" },
    { op: "create", ref: "child", parent: "@parent", name: "Child", type: "prompt", body: "Ready" },
    { op: "create", ref: "independent", name: "Independent", type: "goal", body: "Ready too" },
  ]);
  const before = await fs.readFile(f.filename, "utf8"),
    head = await f.adapter.history.currentCommit();
  const result = await runNodeCommand("write-many", ["--draft", "draft.json"], {
    workspace: f.workspace,
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /@parent.*fill its body.*same tent node write-many --draft/);
  assert.equal(await f.adapter.exists("Independent"), false);
  assert.equal(await f.adapter.exists("Parent"), false);
  assert.equal(await fs.readFile(f.filename, "utf8"), before);
  assert.equal(await f.adapter.history.currentCommit(), head);
});

test("draft mode rejects updates before assigning IDs or mutating either artifact", async (t) => {
  const f = await fixture(t, [
    { op: "create", ref: "ready", name: "Ready", type: "goal", body: "Ready" },
    { op: "update", nodeId: "node-later1", baseEtag: "etag", body: "Update" },
  ]);
  const before = await fs.readFile(f.filename, "utf8"),
    head = await f.adapter.history.currentCommit();
  await assert.rejects(f.save(), /create entries only.*--input-json for updates/);
  assert.equal(await fs.readFile(f.filename, "utf8"), before);
  assert.equal(await f.adapter.history.currentCommit(), head);
  assert.equal(await f.adapter.exists("Ready"), false);
});

for (const failure of ["checkpoint-write", "capture"] as const) {
  test(`ordinary ${failure} failure leaves no Nodes and retains complete retry input`, async (t) => {
    const f = await fixture(t, [
      { op: "create", ref: "ready", name: "Ready", type: "goal", body: "Ready" },
    ]);
    const before = await fs.readFile(f.filename, "utf8"),
      report = await fs.readFile(f.report, "utf8"),
      head = await f.adapter.history.currentCommit();
    const order = (await f.adapter.exists("order.json"))
      ? await f.adapter.readFile("order.json")
      : null;
    let injected = false;
    if (failure === "checkpoint-write") {
      const rename = fs.rename;
      const mocked = t.mock.method(fs, "rename", async (...args: Parameters<typeof rename>) => {
        if (String(args[1]) === f.filename && !injected) {
          injected = true;
          throw new Error("injected checkpoint write failure");
        }
        return rename(...args);
      });
      syncBuiltinESMExports();
      t.after(() => {
        mocked.mock.restore();
        syncBuiltinESMExports();
      });
    } else
      f.adapter.history.captureUnlocked = async () => {
        throw new Error("injected capture failure");
      };
    await assert.rejects(f.save(), /injected/);
    assert.equal(await f.adapter.exists("Ready"), false);
    assert.equal(
      (await f.adapter.exists("order.json")) ? await f.adapter.readFile("order.json") : null,
      order,
    );
    const after = JSON.parse(await fs.readFile(f.filename, "utf8"));
    if (failure === "checkpoint-write") assert.equal(await fs.readFile(f.filename, "utf8"), before);
    else {
      assert.match(after.items[0].id, /^node-/);
      const { id, ...retained } = after.items[0];
      assert.deepEqual(retained, JSON.parse(before).items[0]);
    }
    assert.equal(await fs.readFile(f.report, "utf8"), report);
    assert.equal(await f.adapter.history.currentCommit(), head);
  });
}

test("ordinary final report deletion failure preserves committed Nodes and rolls cleanup back for identity replay", async (t) => {
  const f = await fixture(t, [
    { op: "create", ref: "ready", name: "Ready", type: "goal", body: "Ready" },
  ]);
  const before = await f.adapter.history.currentCommit(),
    report = await fs.readFile(f.report, "utf8");
  const unlink = fs.unlink;
  let injected = false;
  const mocked = t.mock.method(fs, "unlink", async (...args: Parameters<typeof unlink>) => {
    await unlink(...args);
    if (String(args[0]) === f.report && !injected) {
      injected = true;
      throw new Error("injected report delete failure");
    }
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  await assert.rejects(f.save(), /injected report/);
  assert.equal(await f.adapter.exists("Ready/Ready.md"), true);
  const savedHead = await f.adapter.history.currentCommit();
  assert.notEqual(savedHead, before);
  const retry = JSON.parse(await fs.readFile(f.filename, "utf8"));
  assert.match(retry.items[0].id, /^node-/);
  assert.equal(retry.items[0].body, "Ready");
  assert.equal(await fs.readFile(f.report, "utf8"), report);
  await f.save();
  assert.equal(await f.adapter.history.currentCommit(), savedHead);
  assert.equal(
    await fs.stat(f.filename).then(
      () => true,
      () => false,
    ),
    false,
  );
  assert.equal(
    await fs.stat(f.report).then(
      () => true,
      () => false,
    ),
    false,
  );
});

test("an exception after committed capture retains full ID input and replay preserves renamed and edited live Nodes", async (t) => {
  const f = await fixture(t, [
    { op: "create", ref: "ready", name: "Ready", type: "goal", body: "Ready" },
  ]);
  const capture = f.adapter.history.captureUnlocked.bind(f.adapter.history);
  const before = await f.adapter.history.currentCommit();
  f.adapter.history.captureUnlocked = async (...args) => {
    const result = await capture(...args);
    if (args[1]?.operation === "node.write-many")
      throw new Error("injected after committed capture");
    return result;
  };
  await assert.rejects(f.save(), /after committed/);
  assert.notEqual(await f.adapter.history.currentCommit(), before);
  const retry = JSON.parse(await fs.readFile(f.filename, "utf8"));
  assert.equal(retry.items[0].body, "Ready");
  const id = retry.items[0].id;
  f.adapter.history.captureUnlocked = capture;
  await renameNode(f.env, id, "Renamed");
  const live = await readNodeForEdit(f.adapter, id);
  await writeNodeDocument(f.adapter, id, { baseEtag: live.etag, body: "External current body" });
  const changed = await readNodeForEdit(f.adapter, id);
  const head = await f.adapter.history.currentCommit();
  // Saved identity also wins over a later blank draft body and obsolete old path.
  retry.items[0].body = "";
  retry.items.push({
    op: "create",
    ref: "child",
    parent: "@ready",
    name: "Child",
    type: "prompt",
    body: "[parent](@ready)",
    resource: "@ready",
  });
  await fs.writeFile(f.filename, JSON.stringify(retry));
  const result = await f.save();
  assert.equal(result.results[0].path, "Renamed");
  assert.equal(result.results[0].etag, changed.etag);
  assert.equal((await readNodeForEdit(f.adapter, id)).raw, changed.raw);
  assert.equal(await f.adapter.exists("Ready"), false);
  assert.equal(await f.adapter.exists("Renamed/Child/Child.md"), true);
  assert.notEqual(
    await f.adapter.history.currentCommit(),
    head,
    "only new child creates a capture",
  );
  assert.equal(
    await fs.stat(f.filename).then(
      () => true,
      () => false,
    ),
    false,
  );
});

test("postcapture draft conflicts preserve external bytes and name the input while committed Nodes remain saved", async (t) => {
  const f = await fixture(t, [
    { op: "create", ref: "ready", name: "Ready", type: "goal", body: "Ready" },
    { op: "create", ref: "later", name: "Later", type: "goal", body: "" },
  ]);
  const capture = f.adapter.history.captureUnlocked.bind(f.adapter.history);
  f.adapter.history.captureUnlocked = async (...args) => {
    const result = await capture(...args);
    if (args[1]?.operation === "node.write-many") await fs.writeFile(f.filename, "external edit\n");
    return result;
  };
  await assert.rejects(f.save(), (error: unknown) => {
    assert.match(String(error), /Draft file changed/);
    assert.ok(String(error).includes(f.filename));
    return true;
  });
  assert.equal(await f.adapter.exists("Ready/Ready.md"), true);
  assert.equal(await fs.readFile(f.filename, "utf8"), "external edit\n");
});

for (const mode of [
  "draft-invalid",
  "draft-duplicate",
  "batch-invalid",
  "batch-collision",
] as const) {
  test(`fixed create ID authority rejects ${mode} before save`, async (t) => {
    const f = await fixture(t, [
      { op: "create", ref: "one", name: "One", type: "goal", body: "One", id: "node-fixed1" },
    ]);
    const original = JSON.parse(await fs.readFile(f.filename, "utf8"));
    const items = structuredClone(original.items);
    if (mode.endsWith("invalid")) items[0].id = "invalid";
    if (mode === "draft-duplicate") items.push({ ...items[0], ref: "two", name: "Two" });
    if (mode === "batch-collision") await writeNodesBatch(f.env, { items });
    const head = await f.adapter.history.currentCommit();
    if (mode.startsWith("draft")) {
      await fs.writeFile(f.filename, JSON.stringify({ items }));
      const before = await fs.readFile(f.filename, "utf8");
      await assert.rejects(f.save());
      assert.equal(await fs.readFile(f.filename, "utf8"), before);
    } else await assert.rejects(writeNodesBatch(f.env, { items }));
    assert.equal(await f.adapter.history.currentCommit(), head);
    assert.equal(await f.adapter.exists("Two"), false);
    assert.equal(await f.adapter.exists("One"), mode === "batch-collision");
  });
}

test("ordinary input-json batches honor explicit canonical create IDs", async (t) => {
  const f = await fixture(t, [
    { op: "create", ref: "unused", name: "Unused", type: "goal", body: "" },
  ]);
  const response = await runNodeCommand(
    "write-many",
    [
      "--input-json",
      JSON.stringify({
        items: [
          {
            op: "create",
            ref: "fixed",
            id: "node-fixed1",
            name: "Fixed",
            type: "goal",
            body: "Fixed",
          },
        ],
      }),
      "--json",
    ],
    { workspace: f.workspace },
  );
  assert.equal(response.exitCode, 0, response.stderr);
  assert.equal(JSON.parse(response.stdout).results[0].nodeId, "node-fixed1");
});

function childProcess(args: string[], ipc = false) {
  const worker = spawn(process.execPath, args, {
    windowsHide: true,
    stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  worker.stdout!.on("data", (bytes) => {
    stdout += bytes;
  });
  worker.stderr!.on("data", (bytes) => {
    stderr += bytes;
  });
  const done = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    worker.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { worker, done };
}

for (const cut of ["ids-checkpointed", "node-written", "captured"] as const) {
  test(`hard interruption at ${cut} resumes the same CLI command with exactly one of each identity`, async (t) => {
    const f = await fixture(t, [
      {
        op: "create",
        ref: "parent",
        name: "Parent",
        type: "goal",
        body: "Parent body [child](@child)",
      },
      {
        op: "create",
        ref: "child",
        parent: "@parent",
        name: "Child",
        type: "prompt",
        body: "Child body [parent](@parent)",
        sources: [{ resource: "@parent" }],
      },
    ]);
    const head = await f.adapter.history.currentCommit();
    await f.adapter.close();
    const harness = fileURLToPath(new URL("./fixtures/node-write-draft-child.ts", import.meta.url));
    const worker = childProcess(["--import", "tsx", harness, f.workspace, cut], true);
    let ids: string[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out at ${cut}`)), 60_000);
        worker.worker.once("message", (value) => {
          clearTimeout(timeout);
          assert.equal((value as { point: string }).point, cut);
          resolve();
        });
        worker.worker.once("close", async () => {
          clearTimeout(timeout);
          reject(new Error(`Child exited before checkpoint: ${JSON.stringify(await worker.done)}`));
        });
      });
      const checkpoint = JSON.parse(await fs.readFile(f.filename, "utf8"));
      ids = checkpoint.items.map((item: { id: string }) => item.id);
      assert.equal(new Set(ids).size, 2);
      assert.ok(ids.every((id) => /^node-[a-z0-9]+$/i.test(id)));
      assert.deepEqual(
        checkpoint.items.map((item: { body: string }) => item.body),
        ["Parent body [child](@child)", "Child body [parent](@parent)"],
      );
      assert.equal(await fs.readFile(f.report, "utf8"), "complete scan snapshot\n");
      if (cut === "node-written") {
        assert.equal(
          await fs.stat(path.join(f.root, "Parent/Parent.md")).then(
            () => true,
            () => false,
          ),
          true,
        );
        assert.equal(
          await fs.stat(path.join(f.root, ".git/tent-transaction.json")).then(
            () => true,
            () => false,
          ),
          true,
        );
      }
      worker.worker.kill("SIGKILL");
      const killed = await worker.done;
      assert.equal(killed.signal, "SIGKILL");
      t.diagnostic(
        JSON.stringify({
          cut,
          pid: worker.worker.pid,
          signal: killed.signal,
          checkpointIds: ids,
          retainedDraftBodies: checkpoint.items.length,
        }),
      );
    } finally {
      if (worker.worker.exitCode === null && worker.worker.signalCode === null)
        worker.worker.kill("SIGKILL");
      await worker.done;
    }
    // Fresh process executes the identical user command; opening settles pending Node files first.
    const cli = fileURLToPath(new URL("../src/cli/tent.ts", import.meta.url));
    const resumed = await childProcess([
      "--import",
      "tsx",
      cli,
      "node",
      "write-many",
      "--draft",
      "draft.json",
      "--json",
      "--workspace",
      f.workspace,
    ]).done;
    assert.equal(resumed.code, 0, JSON.stringify(resumed));
    assert.deepEqual(
      JSON.parse(resumed.stdout).results.map((item: { nodeId: string }) => item.nodeId),
      ids,
    );
    const reopened = openTestFs(f.root);
    const catalog = await loadNodeCatalog(reopened);
    assert.equal(catalog.byPath.size, 2);
    assert.deepEqual([...catalog.byId.keys()].sort(), [...ids].sort());
    const parent = await readNodeForEdit(reopened, ids[0]!);
    const child = await readNodeForEdit(reopened, ids[1]!);
    assert.match(parent.body, /^Parent body \[child\]\(\.\/Child\/Child.md\)/);
    assert.match(child.body, /^Child body \[parent\]\(\.\.\/Parent.md\)/);
    assert.equal((child.frontmatter.sources as { resource: string }[])[0].resource, "../Parent.md");
    assert.equal(await reopened.exists(".git/tent-transaction.json"), false);
    const events = await reopened.history.changesInRange({ from: head ?? undefined });
    assert.equal(events.filter((event) => event.operation === "node.write-many").length, 1);
    for (const id of ids) {
      const versions = await reopened.history.nodeVersions(id);
      assert.equal(versions.filter((event) => event.operation === "node.write-many").length, 1);
    }
    assert.equal(
      await fs.stat(f.filename).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.equal(
      await fs.stat(f.report).then(
        () => true,
        () => false,
      ),
      false,
    );
  });
}
