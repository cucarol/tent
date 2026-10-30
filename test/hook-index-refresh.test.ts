import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { runHookCommand } from "../src/cli/hook.js";
import { runToolHook } from "../src/cli/tool-hook.js";
import { initializeTentWorkspace } from "../src/fs/workspace-init.js";
import { observeTentSystemRoot } from "../src/core/workspace/status.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { hasNativeGraphWrite } from "../src/cli/native-graph-write.js";
import { removeTestFixture } from "./node-fs.js";
import { initializeFixtureRepository, testScratchRoot } from "./scratch.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "hook-refresh-"));
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  initializeFixtureRepository(root);
  assert.equal((await observeTentSystemRoot(root)).systemRoot, undefined);
  const systemRoot = path.join(root, ".tent");
  const moduleFile = path.join(systemRoot, "Module/Module.md");
  const module = async (
    coverage = "src/",
    status = "",
    host: "codex" | "claude-code" = "codex",
  ) => {
    await fs.mkdir(path.dirname(moduleFile), { recursive: true });
    await fs.writeFile(
      moduleFile,
      `---\nid: node-refresh\ntype: prompt\n${status}sources:\n  - resource: ../../${coverage}\n    track: structure\n---\nRule\n`,
    );
    assert.equal(await notify(".tent/Module/Module.md", "graph", host), "{}\n");
  };
  const start = () =>
    runHookCommand("start", ["--host", "codex"], {
      packageRoot: process.cwd(),
      stdin: JSON.stringify({ hook_event_name: "SessionStart", cwd: root, session_id: "same" }),
    });
  const notify = (file: string, turn = "turn", host: "codex" | "claude-code" = "codex") =>
    runToolHook(host, {
      hook_event_name: "PostToolUse",
      cwd: root,
      session_id: "same",
      turn_id: turn,
      prompt_id: turn,
      tool_name: host === "codex" ? "apply_patch" : "Write",
      tool_input:
        host === "codex"
          ? { command: "*** Begin Patch\n*** End Patch" }
          : { file_path: path.join(root, file) },
      tool_response:
        host === "codex"
          ? `Success. Updated the following files:\nM ${file}\n`
          : { type: "update", filePath: path.join(root, file) },
    });
  const write = async (
    file: string,
    turn = "turn",
    host: "codex" | "claude-code" = "codex",
    content = turn + "\n",
  ) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
    return notify(file, turn, host);
  };
  return { root, systemRoot, moduleFile, module, start, write, notify };
}

test("a session started before Tent initialization names the new module on its next write", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.start()).stdout, "{}\n");
  await initializeTentWorkspace(f.root);
  await f.module();
  assert.match(await f.write("src/code.ts"), /node-refresh/);
  assert.equal(await f.write("src/second.ts"), "{}\n");
});

test("the next native write uses successful native module graph changes in the same session", async (t) => {
  const f = await fixture(t);
  await initializeTentWorkspace(f.root);
  await f.module();
  await f.start();
  await f.module("lib/");
  assert.match(await f.write("lib/code.ts"), /node-refresh/);
  assert.doesNotMatch(await f.write("src/code.ts", "old-coverage"), /node-refresh/);
});

for (const host of ["codex", "claude-code"] as const)
  test(`${host} prepares newly initialized coverage without any SessionStart`, async (t) => {
    const f = await fixture(t);
    await initializeTentWorkspace(f.root);
    await f.module("src/", "", host);
    assert.match(await f.write("src/code.ts", "turn", host), /node-refresh/);
  });

test("native draft, malformed and deleted modules cannot leave stale coverage", async (t) => {
  const f = await fixture(t);
  await initializeTentWorkspace(f.root);
  await f.module();
  await f.start();
  await f.module("src/", "status: draft\n");
  assert.doesNotMatch(await f.write("src/draft.ts", "draft"), /node-refresh/);
  await fs.writeFile(f.moduleFile, "---\nid: node-refresh\nsources: [\n---\n");
  await f.notify(".tent/Module/Module.md");
  assert.doesNotMatch(await f.write("src/invalid.ts", "invalid"), /node-refresh/);
  await f.module();
  assert.match(await f.write("src/restored.ts", "restored"), /node-refresh/);
  await fs.unlink(f.moduleFile);
  await f.notify(".tent/Module/Module.md");
  assert.doesNotMatch(await f.write("src/deleted.ts", "deleted"), /node-refresh/);
});

test("coverage refresh preserves the existing per-turn Node claim", async (t) => {
  const f = await fixture(t);
  await initializeTentWorkspace(f.root);
  await f.module();
  await f.start();
  assert.match(await f.write("src/first.ts"), /node-refresh/);
  await f.module("lib/");
  assert.equal(await f.write("lib/second.ts"), "{}\n");
  assert.match(await f.write("lib/third.ts", "next-turn"), /node-refresh/);
});

test("coverage refresh preserves known section fingerprints after the linked section write", async (t) => {
  const f = await fixture(t);
  await initializeTentWorkspace(f.root);
  await f.module();
  await fs.mkdir(path.join(f.systemRoot, "Linked"));
  await fs.writeFile(
    path.join(f.systemRoot, "Linked/Linked.md"),
    "---\nid: node-linked\ntype: prompt\nsources: [{resource: '../../guide.md#Tracked'}]\n---\nRule\n",
  );
  await fs.writeFile(path.join(f.root, "guide.md"), "# Tracked\nbefore\n");
  await f.start();
  await fs.writeFile(path.join(f.root, "guide.md"), "# Tracked\nafter\n");
  await f.module("lib/");
  assert.match(await f.notify("guide.md"), /node-linked/);
});

test("ordinary hooks after preparation never call the live graph/header loader", async (t) => {
  const f = await fixture(t);
  await initializeTentWorkspace(f.root);
  await f.module();
  assert.match(await f.write("src/first.ts"), /node-refresh/);
  const directories = t.mock.method(NodeFs.prototype, "listDir");
  const headers = t.mock.method(NodeFs.prototype, "readFrontmatterObservation");
  assert.equal(await f.write("src/claimed.ts"), "{}\n");
  assert.match(await f.write("src/next.ts", "next-turn"), /node-refresh/);
  assert.equal(directories.mock.callCount(), 0);
  assert.equal(headers.mock.callCount(), 0);
});

test("init alone prepares unowned-code reminders without a SessionStart", async (t) => {
  const f = await fixture(t);
  await initializeTentWorkspace(f.root);
  assert.match(await f.write("src/new.ts"), /no module Node owns/);
});

test("authoritative Node creation prepares coverage without a SessionStart or graph tool event", async (t) => {
  const f = await fixture(t);
  await initializeTentWorkspace(f.root);
  await fs.mkdir(path.join(f.root, "src"));
  const created = await runNodeCommand(
    "create",
    [
      "Module",
      "--type",
      "prompt",
      "--id",
      "node-refresh",
      "--sources-json",
      JSON.stringify([{ resource: "src/", track: "structure" }]),
    ],
    { workspace: f.root, json: true },
  );
  assert.equal(created.exitCode, 0, created.stderr);
  assert.match(await f.write("src/code.ts"), /node-refresh/);
});

test("authoritative batch, rename, move and delete refresh the resulting graph once their writes finish", async (t) => {
  const f = await fixture(t);
  await initializeTentWorkspace(f.root);
  for (const directory of ["src", "lib"]) await fs.mkdir(path.join(f.root, directory));
  const cli = async (sub: string, args: string[]) => {
    const result = await runNodeCommand(sub, args, { workspace: f.root, json: true });
    assert.equal(result.exitCode, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  await cli("create", [
    "Module",
    "--type",
    "prompt",
    "--id",
    "node-refresh",
    "--sources-json",
    JSON.stringify([{ resource: "src/", track: "structure" }]),
  ]);
  await cli("create", ["Parent", "--type", "prompt", "--id", "node-parent"]);
  const read = await cli("get", ["node-refresh", "--full"]);
  await cli("write-many", [
    "--input-json",
    JSON.stringify({
      items: [
        {
          op: "update",
          nodeId: "node-refresh",
          baseEtag: read.etag,
          frontmatter: { sources: [{ resource: "lib/", track: "structure" }] },
        },
      ],
    }),
  ]);
  assert.match(await f.write("lib/batch.ts", "batch"), /node-refresh/);
  assert.doesNotMatch(await f.write("src/old.ts", "old"), /node-refresh/);
  await cli("rename", ["node-refresh", "Renamed"]);
  assert.match(await f.write("lib/renamed.ts", "rename"), /\.tent\/Renamed\/Renamed\.md/);
  await cli("move", ["node-refresh", "--parent", "node-parent"]);
  assert.match(await f.write("lib/moved.ts", "move"), /\.tent\/Parent\/Renamed\/Renamed\.md/);
  await cli("delete", ["node-refresh"]);
  assert.doesNotMatch(await f.write("lib/deleted.ts", "delete"), /node-refresh/);
});

test("ordinary writes do not inspect arbitrary shell graph edits", async (t) => {
  const f = await fixture(t);
  await initializeTentWorkspace(f.root);
  await f.module();
  await fs.writeFile(
    f.moduleFile,
    (await fs.readFile(f.moduleFile, "utf8")).replace("../../src/", "../../lib/"),
  );
  assert.doesNotMatch(await f.write("lib/code.ts"), /node-refresh/);
  assert.match(await f.write("src/code.ts", "old-prepared"), /node-refresh/);
  await f.start();
  assert.match(await f.write("lib/refreshed.ts", "next-session"), /node-refresh/);
});

test("native graph admission excludes managed, history, temporary and nonidentity files", () => {
  for (const file of [
    ".tent/cards/card-x.md",
    ".tent/roles/role-x.md",
    ".tent/temp/Graph/Graph.md",
    ".tent/.git/Graph/Graph.md",
    ".tent/Module/notes.md",
    ".tent/settings.json",
    "src/code.ts",
  ])
    assert.equal(hasNativeGraphWrite("/workspace", [file]), false, file);
  for (const file of [".tent/index.md", ".tent/Module/Module.md", ".tent/Module/Child/Child.md"])
    assert.equal(hasNativeGraphWrite("/workspace", [file]), true, file);
  assert.equal(
    hasNativeGraphWrite("/workspace", [".TENT/MODULE/module.md"]),
    process.platform === "win32",
  );
  assert.equal(hasNativeGraphWrite("/workspace", [".TENT/ROLES/role-x.md"]), false);
});

test("pending native graph refresh preserves the cache without recovery or normal writer handling", async (t) => {
  const f = await fixture(t);
  await initializeTentWorkspace(f.root);
  await f.module();
  const pending = path.join(f.systemRoot, ".git/tent-transaction.json");
  const history = await fs.readFile(path.join(f.systemRoot, ".git/history.sqlite"));
  const cache = path.join(f.systemRoot, ".git/tent-material-cache/stop-material-index.json");
  const prepared = await fs.readFile(cache);
  await fs.writeFile(pending, "pending-transaction-sentinel\n");
  const lock = t.mock.method(NodeFs.prototype, "withLock", async () => {
    throw new Error("Native refresh must not enter the normal recovery/save boundary");
  });
  await f.module("lib/");
  assert.equal(lock.mock.callCount(), 0);
  assert.equal(await fs.readFile(pending, "utf8"), "pending-transaction-sentinel\n");
  assert.deepEqual(await fs.readFile(cache), prepared);
  assert.deepEqual(await fs.readFile(path.join(f.systemRoot, ".git/history.sqlite")), history);
});

test("native graph refresh revalidates current marker bytes before using coverage", async (t) => {
  const f = await fixture(t);
  await initializeTentWorkspace(f.root);
  await f.module();
  const marker = path.join(f.systemRoot, "index.md");
  const original = await fs.readFile(marker, "utf8");
  await fs.writeFile(marker, "---\ntype: prompt\n---\n");
  assert.equal(await f.notify(".tent/index.md"), "{}\n");
  assert.equal(await f.write("src/invalid-marker.ts"), "{}\n");
  await fs.writeFile(marker, original + "changed marker body\n");
  assert.equal(await f.notify(".tent/index.md"), "{}\n");
  assert.match(await f.write("src/valid-marker.ts"), /node-refresh/);
});
