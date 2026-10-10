import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { serializeFrontmatter } from "../src/core/frontmatter.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { runCardCommand } from "../src/cli/card-commands.js";
import { goalContextText } from "../src/cli/goal-context.js";
import { readGoalContext } from "../src/core/goal-context.js";
import { relatedNodes } from "../src/core/node-query.js";
import { renameNode } from "../src/core/ops.js";
import { SystemClock } from "../src/fs/node-fs.js";
import { runRoleCommand } from "../src/cli/role-commands.js";
import { git } from "./helpers.js";

test("goal get exposes bounded live context without changing document bytes or capturing neighbours", async (t) => {
  await fs.mkdir(path.resolve(".scratch"), { recursive: true });
  const workspace = await fs.mkdtemp(path.resolve(".scratch/goal-context-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
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
  await write("Scope", "node-scope", "prompt", "scope", { tags: ["spec"] });
  await write("Scope/Rule", "node-rule", "prompt", "rule");
  await write("Scope/Goal", "node-goal", "goal", body);
  await write("Scope/Goal/Decision", "node-decision", "prompt", "decision", { tags: ["decision"] });
  await write("Scope/Goal/Result", "node-result", "output", "result", { tags: ["evidence"] });
  await write("Scope/Goal/Nested", "node-nested", "goal", "nested");
  await write("Scope/Goal/Nested/Result", "node-nestedresult", "output", "nested result");
  await write("Scope/Old", "node-old", "prompt", "old", { status: "deprecated" });
  await write("Unrelated", "node-unrelated", "prompt", "unrelated");
  await git(system, "init");
  await git(system, "add", ".");
  await git(system, "commit", "-m", "fixture");
  const globals = { workspace, json: true };
  const parse = (result: { exitCode: number; stdout: string; stderr: string }) => {
    assert.equal(result.exitCode, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const node = async (...args: string[]) =>
    parse(await runNodeCommand("get", [...args, "--context"], globals));
  const created = parse(
    await runCardCommand(
      "create",
      ["--prompt", "Implement goal", "--title", "Request", "--source", "node-goal"],
      globals,
    ),
  );
  await runCardCommand("take", [created.cardId], globals);
  const before = await git(system, "rev-parse", "HEAD");
  await write("Scope/Rule", "node-rule", "prompt", "uncaptured neighbour");
  const context = await readGoalContext(adapter, "node-goal");
  assert.deepEqual(
    context.filter((item) => item.kind === "ancestor").map((item) => item.id),
    ["node-scope"],
  );
  assert.deepEqual(
    context
      .filter(
        (item) =>
          item.kind === "prompt" || (item.kind === "child" && item.type?.startsWith("prompt")),
      )
      .map((item) => item.id),
    ["node-decision", "node-rule"],
  );
  assert.deepEqual(
    new Set(
      context
        .filter(
          (item) =>
            item.kind === "output" || (item.kind === "child" && item.type?.startsWith("output")),
        )
        .map((item) => item.id),
    ),
    new Set(["node-result", "node-nestedresult"]),
  );
  assert.equal(context.find((item) => item.kind === "card")?.state, "consumed");
  assert.equal(context.find((item) => item.kind === "card")?.progress, "received-no-output");
  const first = await node("node-goal");
  assert.ok(Buffer.byteLength(JSON.stringify({ context: first.context })) <= 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 16 * 1024);
  for (const id of ["node-scope", "node-decision", "node-rule", "node-result", created.cardId])
    assert.ok(first.context.includes(id), first.context);
  // The English CLI hint adds no CJK labels of its own; this fixture's names are ASCII.
  assert.doesNotMatch(first.context, /[\p{Script=Han}\u3000-\u303f\uff00-\uffef]/u);
  assert.match(first.context, /^Context\nAncestor Scope node-scope /);
  // Imported outputs have no retained goal basis, so context must expose review debt.
  assert.match(first.context, /stable\/behind/);
  assert.match(first.context, /received-no-output/);
  const continuation = await node(
    "node-goal",
    "--cursor",
    first.page.nextCursor,
    "--expected-etag",
    first.etag,
  );
  assert.equal(continuation.context, undefined);
  const full = await node("node-goal", "--full");
  assert.equal(full.text, body);
  assert.ok(full.context.includes("node-rule"));
  const raw = await node("node-goal", "--full", "--view", "raw");
  assert.equal(raw.text, await fs.readFile(path.join(system, "Scope/Goal/Goal.md"), "utf8"));
  assert.equal(raw.etag, full.etag);
  const frozen = await node(
    "node-goal",
    "--version-json",
    JSON.stringify({ commit: before.trim(), path: "Scope/Goal/Goal.md" }),
  );
  assert.equal(frozen.context, undefined);
  assert.ok((await node("node-decision")).context.includes("node-goal"));
  assert.equal(
    await git(system, "show", "HEAD:Scope/Rule/Rule.md"),
    await git(system, "show", `${before.trim()}:Scope/Rule/Rule.md`),
  );
  const text = await runNodeCommand("get", ["node-goal", "--view", "summary", "--context"], {
    workspace,
  });
  assert.equal(text.exitCode, 0, text.stderr);
  assert.match(text.stdout, /Context/);
  for (let i = 0; i < 30; i++)
    await write(`Scope/Rule${i}`, `node-extra${i}`, "prompt", "large description", {
      description: "超长描述".repeat(1000),
    });
  const crowded = await node("node-goal", "--view", "summary");
  assert.ok(Buffer.byteLength(JSON.stringify({ context: crowded.context })) <= 1024);
  assert.match(
    crowded.context,
    /\nOmitted .*Rule\+\d+.*; continue with node relations <id> --direction parent\|children\|incoming\|outgoing$/,
  );
  assert.ok(crowded.context.includes("node-decision"));
  await write("Lonely", "node-lonely", "goal", "alone");
  assert.equal(await goalContextText(adapter, "node-lonely"), "Context: no related items");
});

test("all Node types disclose complete live association categories and incoming Cards keep their pinned identity after moves", async (t) => {
  await fs.mkdir(path.resolve(".scratch"), { recursive: true });
  const workspace = await fs.mkdtemp(path.resolve(".scratch/node-associations-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  await scaffoldInWorkspace(new NodeFs(workspace), { name: "Associations" });
  const system = path.join(workspace, ".tent"),
    adapter = new NodeFs(system);
  const write = async (folder: string, id: string, type: string, body = "", tags?: string[]) => {
    await adapter.writeFile(
      `${folder}/${path.posix.basename(folder)}.md`,
      serializeFrontmatter({ id, type, ...(tags ? { tags } : {}) }, body),
    );
  };
  await write("Goal", "node-goal00", "goal");
  await write(
    "Goal/Subject",
    "node-subj00",
    "prompt",
    "node-peer00 and `node-peer00`\n" + "Text😀".repeat(5000),
  );
  await write("Goal/Subject/A", "node-chld01", "output", "", ["evidence"]);
  await write("Goal/Subject/B", "node-chld02", "goal", "", ["requirement"]);
  await write("Goal/Subject/C", "node-chld03", "prompt", "", ["reference"]);
  await write("Goal/Output", "node-outp00", "output", "", ["evidence"]);
  await write("Peer", "node-peer00", "prompt", "node-subj00");
  await adapter.writeFile(
    "roles/role-reader.md",
    serializeFrontmatter(
      { id: "role-reader", type: "role", title: "Reader" },
      "[Subject](../Goal/Subject/Subject.md) and node-subj00",
    ),
  );
  await git(system, "init");
  await git(system, "add", ".");
  await git(system, "commit", "-m", "fixture");
  const globals = { workspace, json: true };
  const parse = (result: { exitCode: number; stdout: string; stderr: string }) => {
    assert.equal(result.exitCode, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const card = parse(
    await runCardCommand(
      "create",
      ["--prompt", "Read node-subj00", "--source", "node-subj00"],
      globals,
    ),
  );
  await renameNode(
    { fs: adapter, clock: new SystemClock(), tentName: "Associations" },
    "node-subj00",
    "Renamed",
  );
  await write("Goal/Subject", "node-repl00", "prompt", "Replacement");
  await adapter.writeFile(
    "roles/role-invalid.md",
    "---\nid: role-invalid\ntype: role\nunclosed: [\n---\nnode-subj00",
  );
  await adapter.writeFile(
    "cards/card-invalid.md",
    "---\nid: card-invalid\ntype: card\n---\nnode-subj00",
  );
  const associations = await readGoalContext(adapter, "node-subj00");
  assert.deepEqual(
    associations.filter((item) => item.kind === "child").map((item) => item.type),
    ["goal", "output", "prompt"],
  );
  for (const [kind, id] of [
    ["ancestor", "node-goal00"],
    ["incoming", "node-peer00"],
    ["incoming", "role-reader"],
    ["outgoing", "node-peer00"],
    ["card", card.cardId],
  ])
    assert.ok(
      associations.some((item) => item.kind === kind && item.id === id),
      `${kind} ${id}`,
    );
  assert.deepEqual(associations.find((item) => item.id === "role-reader")?.relationKinds, [
    "link",
    "mention",
  ]);
  const pinned = associations.find((item) => item.kind === "card")!;
  assert.equal(pinned.state, "pending");
  assert.equal(pinned.progress, null); // A prompt source contributes no pinned goals.
  const incoming = (
    await relatedNodes(adapter, "ws-test", { nodeId: "node-subj00", direction: "incoming" })
  ).items;
  assert.ok(
    incoming.some(
      (relation) =>
        (relation.from as { cardId?: string }).cardId === card.cardId &&
        relation.kind === "material",
    ),
  );
  assert.ok(
    incoming.some(
      (relation) =>
        (relation.from as { roleId?: string }).roleId === "role-reader" && relation.kind === "link",
    ),
  );
  assert.ok(incoming.some((relation) => relation.kind === "mention"));
  const cliIncoming = parse(
    await runNodeCommand("relations", ["node-subj00", "--direction", "incoming"], globals),
  );
  const roleRead = cliIncoming.items.find(
    (relation: { from: { roleId?: string } }) => relation.from.roleId === "role-reader",
  ).read;
  const cardRead = cliIncoming.items.find(
    (relation: { from: { cardId?: string }; kind: string }) =>
      relation.from.cardId === card.cardId && relation.kind === "mention",
  ).read;
  const cardArgs = [
    cardRead.cardId,
    "--view",
    cardRead.view,
    "--start",
    String(cardRead.range.start),
    "--end",
    String(cardRead.range.end),
    "--expected-etag",
    cardRead.expectedEtag,
  ];
  assert.equal((await runCardCommand("get", cardArgs, globals)).exitCode, 0);
  const roleArgs = [
    roleRead.roleId,
    "--view",
    roleRead.view,
    "--start",
    String(roleRead.range.start),
    "--end",
    String(roleRead.range.end),
    "--expected-etag",
    roleRead.expectedEtag,
  ];
  assert.equal((await runRoleCommand("show", roleArgs, globals)).exitCode, 0);
  const roleRaw = await adapter.readFile("roles/role-reader.md");
  await adapter.writeFile("roles/role-reader.md", roleRaw + "\nChanged direction");
  const staleRole = await runRoleCommand("show", roleArgs, globals);
  assert.equal(staleRole.exitCode, 1);
  assert.match(staleRole.stderr, /Role changed/);
  const replacement = (
    await relatedNodes(adapter, "ws-test", { nodeId: "node-repl00", direction: "incoming" })
  ).items;
  assert.ok(
    !replacement.some((relation) => (relation.from as { cardId?: string }).cardId === card.cardId),
  );
  const first = parse(await runNodeCommand("get", ["node-subj00", "--context"], globals));
  const repeated = parse(await runNodeCommand("get", ["node-subj00", "--context"], globals));
  assert.equal(first.context, repeated.context);
  assert.ok(Buffer.byteLength(JSON.stringify({ context: first.context })) <= 1024);
  const continuation = parse(
    await runNodeCommand(
      "get",
      ["node-subj00", "--cursor", first.page.nextCursor, "--expected-etag", first.etag],
      globals,
    ),
  );
  assert.equal(continuation.context, undefined);
  const output = parse(
    await runNodeCommand("get", ["node-outp00", "--full", "--context"], globals),
  );
  assert.match(output.context, /Goal.*node-goal00/);
  assert.match(output.context, /Self.*stable\/behind/);
  const historical = parse(
    await runNodeCommand(
      "get",
      [
        "node-outp00",
        "--version-json",
        JSON.stringify({
          commit: await adapter.history.currentCommit(),
          path: "Goal/Output/Output.md",
        }),
      ],
      globals,
    ),
  );
  assert.equal(historical.context, undefined);
  for (let i = 0; i < 45; i++)
    await write(`Goal/Renamed/Extra${i}`, `node-extra${i}`, "prompt", "More");
  const crowded = parse(
    await runNodeCommand("get", ["node-subj00", "--view", "summary", "--context"], globals),
  );
  assert.ok(Buffer.byteLength(JSON.stringify({ context: crowded.context })) <= 1024);
  assert.match(crowded.context, /Omitted.*Child\+\d+.*node relations/);
  const cardRaw = await adapter.readFile(`cards/${card.cardId}.md`);
  await adapter.writeFile(`cards/${card.cardId}.md`, cardRaw + "\nChanged Card");
  const staleCard = await runCardCommand("get", cardArgs, globals);
  assert.equal(staleCard.exitCode, 1);
  assert.match(staleCard.stderr, /Card changed/);
  const readBinary = adapter.readBinary.bind(adapter);
  adapter.readBinary = async (file) => {
    if (file === "roles/role-reader.md")
      throw Object.assign(new Error("fixture read denied"), { code: "EACCES" });
    return readBinary(file);
  };
  await assert.rejects(() => readGoalContext(adapter, "node-subj00"), /fixture read denied/);
});
