import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { serializeFrontmatter } from "../src/core/frontmatter.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { runCardCommand } from "../src/cli/card-commands.js";
import { readGoalContext } from "../src/core/goal-context.js";
import { git } from "./helpers.js";

test("goal get exposes bounded live context without changing document bytes or capturing neighbours", async (t) => {
  await fs.mkdir(path.resolve(".scratch"), { recursive: true });
  const workspace = await fs.mkdtemp(path.resolve(".scratch/goal-context-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await scaffoldInWorkspace(new NodeFs(workspace), { name: "Context" });
  const system = path.join(workspace, ".tent");
  const adapter = new NodeFs(system);
  const write = async (folder: string, id: string, type: string, body: string, extra = {}) => {
    await fs.mkdir(path.join(system, folder), { recursive: true });
    await fs.writeFile(
      path.join(system, folder, `${path.basename(folder)}.md`),
      serializeFrontmatter({ id, type, description: "useful description", ...extra }, body),
    );
  };
  const body = "目标正文\n" + "长文😀".repeat(6000);
  await write("Scope", "node-scope", "prompt-spec", "scope");
  await write("Scope/Rule", "node-rule", "prompt-rule", "rule");
  await write("Scope/Goal", "node-goal", "goal-requirement", body);
  await write("Scope/Goal/Decision", "node-decision", "prompt-decision", "decision");
  await write("Scope/Goal/Result", "node-result", "output-evidence", "result");
  await write("Scope/Goal/Nested", "node-nested", "goal", "nested");
  await write("Scope/Goal/Nested/Result", "node-nestedresult", "output", "nested result");
  await write("Scope/Old", "node-old", "prompt-rule", "old", { status: "deprecated" });
  await write("Unrelated", "node-unrelated", "prompt", "unrelated");
  await git(system, "init");
  await git(system, "add", ".");
  await git(system, "commit", "-m", "fixture");
  const globals = { workspace, json: true };
  const parse = (result: { exitCode: number; stdout: string; stderr: string }) => {
    assert.equal(result.exitCode, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const node = async (...args: string[]) => parse(await runNodeCommand("get", args, globals));
  const created = parse(
    await runCardCommand(
      "create",
      ["--prompt", "Implement goal", "--title", "Request", "--source", "/Scope/Goal/Goal.md"],
      globals,
    ),
  );
  await runCardCommand("take", [created.cardId], globals);
  const before = await git(system, "rev-parse", "HEAD");
  await write("Scope/Rule", "node-rule", "prompt-rule", "uncaptured neighbour");
  const context = await readGoalContext(adapter, "node-goal");
  assert.deepEqual(
    context.filter((item) => item.kind === "ancestor").map((item) => item.id),
    ["node-scope"],
  );
  assert.deepEqual(
    context.filter((item) => item.kind === "prompt").map((item) => item.id),
    ["node-decision", "node-rule"],
  );
  assert.deepEqual(
    new Set(context.filter((item) => item.kind === "output").map((item) => item.id)),
    new Set(["node-result", "node-nestedresult"]),
  );
  assert.equal(context.find((item) => item.kind === "card")?.state, "received-no-output");
  const first = await node("node-goal");
  assert.ok(Buffer.byteLength(JSON.stringify({ context: first.context })) <= 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 16 * 1024);
  for (const id of ["node-scope", "node-decision", "node-rule", "node-result", created.cardId])
    assert.ok(first.context.includes(id), first.context);
  assert.match(first.context, /stable\/unanchored/);
  assert.match(first.context, /received-no-output/);
  const continuation = await node(
    "node-goal",
    "--cursor",
    first.node.page.nextCursor,
    "--expected-etag",
    first.node.etag,
  );
  assert.equal(continuation.context, undefined);
  const full = await node("node-goal", "--full");
  assert.equal(full.node.text, body);
  assert.ok(full.context.includes("node-rule"));
  const raw = await node("node-goal", "--full", "--view", "raw");
  assert.equal(raw.node.text, await fs.readFile(path.join(system, "Scope/Goal/Goal.md"), "utf8"));
  assert.equal(raw.node.etag, full.node.etag);
  const frozen = await node("node-goal", "--version-json", JSON.stringify(full.node.version));
  assert.equal(frozen.context, undefined);
  assert.equal((await node("node-decision")).context, undefined);
  assert.equal(
    await git(system, "show", "HEAD:Scope/Rule/Rule.md"),
    await git(system, "show", `${before.trim()}:Scope/Rule/Rule.md`),
  );
  const text = await runNodeCommand("get", ["node-goal", "--view", "summary"], { workspace });
  assert.equal(text.exitCode, 0, text.stderr);
  assert.match(text.stdout, /上下文/);
  for (let i = 0; i < 30; i++)
    await write(`Scope/Rule${i}`, `node-extra${i}`, "prompt", "large description", {
      description: "超长描述".repeat(1000),
    });
  const crowded = await node("node-goal", "--view", "summary");
  assert.ok(Buffer.byteLength(JSON.stringify({ context: crowded.context })) <= 1024);
  assert.match(crowded.context, /省略/);
  assert.ok(crowded.context.includes("node-decision"));
});
