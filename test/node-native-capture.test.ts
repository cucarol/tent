import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { initializeTentWorkspace } from "../src/fs/workspace-init.js";
import { createNode } from "../src/core/ops.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { runRoleCommand } from "../src/cli/role-commands.js";
import { runCardCommand } from "../src/cli/card-commands.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { runHookCommand } from "../src/cli/hook.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { captureNativeNodeEdits } from "../src/core/node-native-capture.js";
import { inspectWorkspaceSync } from "../src/core/node-sync.js";

async function fixture(t: TestContext) {
  await fs.mkdir(path.resolve(".scratch"), { recursive: true });
  const workspace = await fs.mkdtemp(path.resolve(".scratch/native-node-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  await initializeTentWorkspace(workspace);
  const adapter = new NodeFs(path.join(workspace, ".tent"));
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
  assert.equal(captured.catalog?.observedDocuments?.get(output)?.raw, latest);
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

test("sync rechecks native boundary snapshots before returning a judgment", async (t) => {
  const { adapter, output } = await fixture(t);
  const observed = await captureNativeNodeEdits(adapter);
  const goalFile = "需求/需求.md";
  await adapter.writeFile(goalFile, (await adapter.readFile(goalFile)) + "\nChanged after capture");
  const sync = await inspectWorkspaceSync(
    adapter,
    undefined,
    observed.invalidNodes,
    observed.catalog,
  );
  assert.ok(sync.nodes.find((node) => node.nodeId === output)?.behind);
});

test("native body saves retain exact bytes and old bases; node get is pure and two observed edits survive", async (t) => {
  const { workspace, adapter, goal, output, options, parse } = await fixture(t);
  const file = "需求/结果/结果.md";
  const beforeHead = await adapter.history.currentCommit();
  const beforeRecord = (await adapter.history.nodeRecords())[output];
  const original = await adapter.readFile(file);
  await fs.writeFile(path.join(workspace, "input.txt"), "changed material");
  const first = original + "\nAgent A adds a note.";
  await adapter.writeFile(file, first);
  for (const args of [[], ["--full"], ["--view", "raw"]]) {
    const read = parse(await runNodeCommand("get", [output, ...args], options));
    assert.deepEqual(Object.keys(read).sort(), ["etag", "nodeId", "text"]);
    assert.equal(await adapter.history.currentCommit(), beforeHead);
    assert.equal(await adapter.readFile(file), first);
  }
  const brief = parse(await runWorkspaceCommand("brief", [], options));
  assert.equal(brief.counts.behind, 2);
  const firstHead = await adapter.history.currentCommit();
  assert.notEqual(firstHead, beforeHead);
  assert.equal(await adapter.history.read({ commit: firstHead!, path: file }), first);
  assert.deepEqual(
    (await new NodeFs(path.join(workspace, ".tent")).history.nodeRecords())[output],
    beforeRecord,
  );
  const second = first + "\nAgent B preserves A and adds a note.";
  await adapter.writeFile(file, second);
  const checked = parse(await runNodeCommand("check", [goal], options));
  assert.ok(checked.behind);
  const secondHead = await adapter.history.currentCommit();
  assert.notEqual(secondHead, firstHead);
  assert.equal(await adapter.history.read({ commit: secondHead!, path: file }), second);
  assert.equal(await adapter.history.read({ commit: firstHead!, path: file }), first);
  assert.deepEqual(
    (await new NodeFs(path.join(workspace, ".tent")).history.nodeRecords())[output],
    beforeRecord,
  );
  // A complete pure read remains usable when a following command records those exact native bytes.
  const third = second + "\nThird note";
  await adapter.writeFile(file, third);
  const read = parse(await runNodeCommand("get", [output], options));
  parse(
    await runNodeCommand(
      "write",
      [output, "--base-etag", read.etag, "--body", read.text + "\nCLI note"],
      options,
    ),
  );
  assert.deepEqual(
    (await new NodeFs(path.join(workspace, ".tent")).history.nodeRecords())[output],
    beforeRecord,
  );
  const full = parse(await runNodeCommand("get", [output], options));
  parse(await runNodeCommand("confirm", [output, "--base-etag", full.etag], options));
  assert.equal(parse(await runNodeCommand("check", [output], options)).behind, undefined);
});

test("valid native metadata retains old material bases and records newly declared materials", async (t) => {
  const { workspace, adapter, goal, options, parse } = await fixture(t);
  const previous = (await adapter.history.nodeRecords())[goal]!;
  await fs.writeFile(path.join(workspace, "input.txt"), "changed old material");
  await fs.writeFile(path.join(workspace, "新材料.txt"), "new material");
  const document = parseFrontmatter(await adapter.readFile("需求/需求.md"));
  document.data.sources = [{ resource: "../../新材料.txt" }];
  const raw = serializeFrontmatter(document.data, document.body, document.keyOrder);
  await adapter.writeFile("需求/需求.md", raw);
  const checked = parse(await runNodeCommand("check", [goal], options));
  assert.ok(checked.behind);
  const current = (await new NodeFs(path.join(workspace, ".tent")).history.nodeRecords())[goal]!;
  assert.deepEqual(current.materials[0], previous.materials[0]);
  assert.equal(current.materials.length, 2);
  assert.match(current.materials[1]!.version!, /^[a-f0-9]{64}$/);
  assert.equal(await adapter.readFile("需求/需求.md"), raw);
});

for (const malformed of ["yaml", "schema"] as const)
  test(`native ${malformed} errors remain untouched and visible in brief and check`, async (t) => {
    const { adapter, goal, output, options, parse } = await fixture(t);
    const file = "需求/结果/结果.md";
    const previous = await adapter.history.currentCommit();
    const original = await adapter.readFile(file);
    const raw =
      malformed === "yaml"
        ? original.replace("type: output", "type: [")
        : original.replace("type: output", "type: invalid");
    await adapter.writeFile(file, raw);
    const brief = parse(await runWorkspaceCommand("brief", [], options));
    assert.equal(brief.invalidNodes.length, 1);
    assert.equal(brief.invalidNodes[0].path, `.tent/${file}`);
    assert.ok(brief.invalidNodes[0].reason);
    const text = await runWorkspaceCommand("brief", [], { ...options, json: false });
    assert.match(text.stdout.split("\n")[1]!, /^Invalid Nodes:/);
    const checked = await runWorkspaceCommand("check", [], options);
    assert.equal(checked.exitCode, 1);
    assert.match(checked.stdout, /结果/);
    assert.equal(await adapter.readFile(file), raw);
    assert.equal(await adapter.history.currentCommit(), previous);
    assert.equal((await runNodeCommand("get", [output], options)).exitCode, 1);
    const renamed = await runNodeCommand("rename", [goal, "Moved"], options);
    assert.equal(renamed.exitCode, 1);
    assert.equal(await adapter.readFile(file), raw);
    assert.equal(await adapter.exists("Moved"), false);
    assert.equal(await adapter.history.currentCommit(), previous);
  });

test("Node discovery and relation endpoints expose exact Workspace file paths", async (t) => {
  const { goal, output, options, parse } = await fixture(t);
  const listed = parse(await runNodeCommand("list", [], options));
  assert.equal(
    listed.items.find((item: { nodeId: string }) => item.nodeId === goal).path,
    ".tent/需求/需求.md",
  );
  const summary = parse(await runNodeCommand("get", [output, "--view", "summary"], options));
  assert.equal(summary.path, ".tent/需求/结果/结果.md");
  const relations = parse(
    await runNodeCommand("relations", [goal, "--direction", "children"], options),
  );
  assert.equal(relations.items[0].path, ".tent/需求/结果/结果.md");
  parse(
    await runRoleCommand(
      "create",
      ["--id", "role-reader", "--title", "Reader", "--body", `Reads ${goal}`],
      options,
    ),
  );
  parse(
    await runCardCommand(
      "create",
      ["--id", "card-reader", "--prompt", "Read", "--source", goal],
      options,
    ),
  );
  parse(
    await runNodeCommand(
      "append",
      [output, "--body", "[Role](../../roles/role-reader.md) [Card](../../cards/card-reader.md)"],
      options,
    ),
  );
  const outgoing = parse(
    await runNodeCommand("relations", [output, "--direction", "outgoing"], options),
  );
  assert.equal(
    outgoing.items.find(
      (item: { target: { roleId?: string } }) => item.target.roleId === "role-reader",
    ).target.path,
    ".tent/roles/role-reader.md",
  );
  assert.equal(
    outgoing.items.find(
      (item: { target: { cardId?: string } }) => item.target.cardId === "card-reader",
    ).target.path,
    ".tent/cards/card-reader.md",
  );
  const incoming = parse(
    await runNodeCommand("relations", [goal, "--direction", "incoming"], options),
  );
  assert.equal(
    incoming.items.find((item: { from: { roleId?: string } }) => item.from.roleId === "role-reader")
      .from.path,
    ".tent/roles/role-reader.md",
  );
});

test("an unretained invalid descendant cannot be moved or captured through its valid parent", async (t) => {
  const { adapter, goal, options, parse } = await fixture(t);
  const head = await adapter.history.currentCommit();
  const file = "需求/坏文件/坏文件.md";
  const raw = "---\nid: node-badnative\ntype: invalid\n---\nKeep these bytes";
  await adapter.writeFile(file, raw);
  const brief = parse(await runWorkspaceCommand("brief", [], options));
  assert.ok(brief.invalidNodes.some((item: { path: string }) => item.path === `.tent/${file}`));
  assert.equal((await runNodeCommand("rename", [goal, "Moved"], options)).exitCode, 1);
  assert.equal(await adapter.readFile(file), raw);
  assert.equal(await adapter.exists("Moved"), false);
  assert.equal(await adapter.history.currentCommit(), head);
});

test("SessionStart records native edits before its history baseline", async (t) => {
  const { workspace, adapter } = await fixture(t);
  const file = "需求/需求.md";
  const raw = (await adapter.readFile(file)) + "\nNative before hook";
  await adapter.writeFile(file, raw);
  const result = await runHookCommand("start", ["--host", "codex"], {
    packageRoot: path.resolve("."),
    stdin: JSON.stringify({
      hook_event_name: "SessionStart",
      cwd: workspace,
      session_id: "native-test",
    }),
  });
  assert.equal(result.exitCode, 0);
  const head = await adapter.history.currentCommit();
  assert.equal(await adapter.history.read({ commit: head!, path: file }), raw);
});
