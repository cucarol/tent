import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

test("pure CLI reads leave native Node, Role and Card edits unretained", async (t) => {
  const { workspace, adapter, goal, output, options, parse } = await fixture(t);
  const role = parse(
    await runRoleCommand("create", ["--id", "role-reader", "--title", "Reader"], options),
  );
  const card = parse(
    await runCardCommand(
      "create",
      ["--id", "card-reader", "--prompt", "Read", "--source", goal, "--target", role.roleId],
      options,
    ),
  );
  for (const args of [
    ["init"],
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ],
  ])
    await promisify(execFile)("git", ["-C", workspace, ...args], { windowsHide: true });
  const beforeHead = await adapter.history.currentCommit();
  const beforeRecords = await adapter.history.nodeRecords();
  const nodeFile = "需求/结果/结果.md";
  const roleFile = `roles/${role.roleId}.md`;
  const cardFile = `cards/${card.cardId}.md`;
  const nativeNode = (await adapter.readFile(nodeFile)) + "\nNative output";
  const nativeRole = (await adapter.readFile(roleFile)) + "\nNative Role";
  const nativeCard = (await adapter.readFile(cardFile)).replace(
    "schemaVersion: 3",
    "schemaVersion: 3 # native formatting",
  );
  await adapter.writeFile(nodeFile, nativeNode);
  await adapter.writeFile(roleFile, nativeRole);
  await adapter.writeFile(cardFile, nativeCard);
  const reads = [
    ...[[], ["--full"], ["--view", "raw"], ["--context"]].map((args) => ({
      label: `node get ${args.join(" ")}`,
      run: () => runNodeCommand("get", [output, ...args], options),
    })),
    { label: "node list", run: () => runNodeCommand("list", [], options) },
    { label: "node list --full", run: () => runNodeCommand("list", ["--full"], options) },
    {
      label: "node search",
      run: () => runNodeCommand("search", ["--resource", "input.txt"], options),
    },
    {
      label: "node relations",
      run: () => runNodeCommand("relations", [goal, "--direction", "incoming"], options),
    },
    { label: "node history", run: () => runNodeCommand("history", [output], options) },
    { label: "node tags", run: () => runNodeCommand("tags", [], options) },
    { label: "role list", run: () => runRoleCommand("list", [], options) },
    { label: "role show", run: () => runRoleCommand("show", [role.roleId], options) },
    { label: "card list", run: () => runCardCommand("list", [], options) },
    { label: "card show", run: () => runCardCommand("show", [card.cardId], options) },
    { label: "card get", run: () => runCardCommand("get", [card.cardId], options) },
    {
      label: "card watch",
      run: () => runCardCommand("watch", ["--role", role.roleId, "--timeout", "0"], options),
    },
    { label: "workspace scan", run: () => runWorkspaceCommand("scan", [], options) },
  ];
  for (const { label, run } of reads) {
    parse(await run());
    assert.equal(await adapter.history.currentCommit(), beforeHead, label);
    assert.deepEqual(await adapter.history.nodeRecords(), beforeRecords, label);
    assert.equal(await adapter.readFile(nodeFile), nativeNode, label);
    assert.equal(await adapter.readFile(roleFile), nativeRole, label);
    assert.equal(await adapter.readFile(cardFile), nativeCard, label);
  }
  parse(await runWorkspaceCommand("brief", [], options));
  const collectedHead = await adapter.history.currentCommit();
  assert.notEqual(collectedHead, beforeHead);
  assert.equal(await adapter.history.read({ commit: collectedHead!, path: nodeFile }), nativeNode);
  assert.deepEqual(await adapter.history.nodeRecords(), beforeRecords);
});

test("pure readers return live bytes and mark them while relations wait for capture", async (t) => {
  const { adapter, goal, output, options, parse } = await fixture(t);
  const role = parse(
    await runRoleCommand("create", ["--id", "role-live", "--title", "Live"], options),
  );
  const file = "需求/结果/结果.md";
  const before = parse(await runNodeCommand("get", [output, "--context"], options));
  const relations = parse(
    await runNodeCommand("relations", [output, "--direction", "outgoing"], options),
  );
  assert.equal(before.uncaptured, undefined);
  const head = await adapter.history.currentCommit();
  const records = await adapter.history.nodeRecords();
  const raw = (await adapter.readFile(file)) + "\n[Live role](../../roles/role-live.md)";
  await adapter.writeFile(file, raw);
  const live = parse(await runNodeCommand("get", [output, "--context"], options));
  assert.equal(live.uncaptured, true);
  assert.match(live.text, /Live role/);
  assert.equal(live.context, before.context);
  assert.deepEqual(
    parse(await runNodeCommand("relations", [output, "--direction", "outgoing"], options)),
    relations,
  );
  const plain = await runNodeCommand("get", [output], { ...options, json: false });
  assert.equal(plain.exitCode, 0, plain.stderr);
  assert.match(plain.stdout, /有未收录的改动，下一次写命令、brief 或 hook 时收录。/);
  const roleFile = `roles/${role.roleId}.md`;
  await adapter.writeFile(roleFile, (await adapter.readFile(roleFile)) + "\nNative role body");
  assert.equal(parse(await runRoleCommand("show", [role.roleId], options)).uncaptured, true);
  assert.equal(await adapter.history.currentCommit(), head);
  assert.deepEqual(await adapter.history.nodeRecords(), records);
  assert.equal(await adapter.readFile(file), raw);
  parse(await runWorkspaceCommand("brief", [], options));
  assert.equal(parse(await runNodeCommand("get", [output], options)).uncaptured, undefined);
  const captured = parse(
    await runNodeCommand("relations", [output, "--direction", "outgoing"], options),
  );
  assert.ok(
    captured.items.some(
      (item: { target: { roleId?: string } }) => item.target.roleId === role.roleId,
    ),
  );
  assert.equal(parse(await runNodeCommand("get", [goal], options)).uncaptured, undefined);
});

test("Card progress uses retained output declarations and current material bytes without advancing bases", async (t) => {
  const { workspace, adapter, goal, options, parse } = await fixture(t);
  const card = parse(
    await runCardCommand(
      "create",
      ["--id", "card-retained", "--prompt", "Deliver", "--source", goal],
      options,
    ),
  );
  parse(await runCardCommand("take", [card.cardId], options));
  await fs.writeFile(path.join(workspace, "response.txt"), "delivered material");
  const output = parse(
    await runNodeCommand(
      "link-output",
      [goal, "--card", card.cardId, "--resource", "response.txt", "--name", "Delivered"],
      options,
    ),
  );
  const read = () => runCardCommand("show", [card.cardId], options).then(parse);
  assert.equal((await read()).progress, "has-output");
  const head = await adapter.history.currentCommit();
  const records = await adapter.history.nodeRecords();
  const file = "需求/Delivered/Delivered.md";
  const original = await adapter.readFile(file);
  const parsed = parseFrontmatter(original);
  const edited = serializeFrontmatter(
    { ...parsed.data, status: "deprecated" },
    parsed.body,
    parsed.keyOrder,
  );
  await adapter.writeFile(file, edited);
  assert.equal(
    parse(await runNodeCommand("get", [output.nodeId, "--view", "raw"], options)).uncaptured,
    true,
  );
  assert.equal((await read()).progress, "has-output");
  await fs.writeFile(path.join(workspace, "response.txt"), "changed since delivery");
  const drifted = await read();
  assert.equal(drifted.progress, "needs-review");
  assert.deepEqual(drifted.reviewOutputNodeIds, [output.nodeId]);
  const listed = parse(await runCardCommand("list", [], options));
  assert.equal(
    listed.items.find((item: { cardId: string }) => item.cardId === card.cardId).progress,
    "needs-review",
  );
  await fs.writeFile(path.join(workspace, "response.txt"), "delivered material");
  assert.equal((await read()).progress, "has-output");
  assert.equal(await adapter.history.currentCommit(), head);
  assert.deepEqual(await adapter.history.nodeRecords(), records);
  assert.equal(await adapter.readFile(file), edited);
  parse(await runWorkspaceCommand("brief", [], options));
  assert.equal((await read()).progress, "received-no-output");
});

test("uncaptured new and moved Nodes remain live in discovery and export", async (t) => {
  const { workspace, adapter, goal, output, options, parse } = await fixture(t);
  const head = await adapter.history.currentCommit();
  const records = await adapter.history.nodeRecords();
  await fs.rename(path.join(workspace, ".tent/需求/结果"), path.join(workspace, ".tent/结果"));
  await adapter.writeFile(
    "结果/结果.md",
    (await adapter.readFile("结果/结果.md")).replace(
      "type: output",
      "type: output\nresource: ../../input.txt",
    ) + "\nDiscovery needle",
  );
  const newId = "node-nativenew";
  await adapter.writeFile(
    "新增/新增.md",
    `---\nid: ${newId}\ntype: prompt\nresource: ../../input.txt\n---\nDiscovery needle`,
  );
  const listed = parse(await runNodeCommand("list", [], options));
  const searched = parse(await runNodeCommand("search", ["--resource", "input.txt"], options));
  const exported = parse(await runNodeCommand("list", ["--full"], options));
  for (const items of [listed.items, searched.items, exported.nodes]) {
    for (const [id, file] of [
      [newId, "新增/新增.md"],
      [output, "结果/结果.md"],
    ]) {
      const item = items.find((entry: { nodeId: string }) => entry.nodeId === id);
      assert.ok(item, id);
      assert.equal(item.path, `.tent/${file}`);
      assert.equal(item.uncaptured, true);
    }
  }
  const summary = parse(await runNodeCommand("get", [output, "--view", "summary"], options));
  assert.equal(summary.path, ".tent/结果/结果.md");
  assert.equal(summary.uncaptured, true);
  const materialHits = parse(await runNodeCommand("search", ["--resource", "input.txt"], options));
  assert.ok(
    materialHits.items.some(
      (item: { nodeId: string; uncaptured?: boolean }) => item.nodeId === newId && item.uncaptured,
    ),
  );
  const batch = parse(await runNodeCommand("read-many", [newId, output], options));
  assert.equal(batch.items[0].resource, "../../input.txt");
  assert.match(batch.items[0].text, /Discovery needle/);
  assert.ok(batch.items.every((item: { uncaptured?: boolean }) => item.uncaptured));
  const retainedChildren = parse(
    await runNodeCommand("relations", [goal, "--direction", "children"], options),
  );
  assert.equal(
    retainedChildren.items.find((item: { nodeId: string }) => item.nodeId === output).path,
    ".tent/需求/结果/结果.md",
  );
  for (const args of [[], ["--full"]]) {
    const text = await runNodeCommand("list", args, { ...options, json: false });
    assert.equal(text.exitCode, 0, text.stderr);
    assert.match(text.stdout, /有未收录的改动，下一次写命令、brief 或 hook 时收录。/);
  }
  assert.equal(await adapter.history.currentCommit(), head);
  assert.deepEqual(await adapter.history.nodeRecords(), records);
  assert.equal(await adapter.exists("需求/结果/结果.md"), false);
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
    assert.deepEqual(Object.keys(read).sort(), ["etag", "nodeId", "text", "uncaptured"]);
    assert.equal(read.uncaptured, true);
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
  const nativeWrite = (await adapter.history.nodeVersions(output))
    .filter((version) => version.operation === "node.native-save")
    .at(-1);
  assert.ok(nativeWrite);
  assert.equal(await adapter.history.read({ commit: nativeWrite.commit, path: file }), third);
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
