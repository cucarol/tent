import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { nodeHelpText, runNodeCommand } from "../src/cli/node-commands.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { runCardCommand } from "../src/cli/card-commands.js";
import { runRoleCommand } from "../src/cli/role-commands.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { git } from "./helpers.js";

async function fixture(t: TestContext) {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "cli-material-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await scaffoldInWorkspace(new NodeFs(root), {
    name: "CLI materials",
    nodes: [{ id: "node-goal", name: "Goal", type: "goal", body: "Deliver evidence." }],
  });
  await git(path.join(root, ".tent"), "init");
  await fs.mkdir(path.join(root, "docs"));
  await fs.writeFile(path.join(root, "docs/req.md"), "# Requirements\nFirst.\n");
  await fs.writeFile(path.join(root, "docs/proof.txt"), "Proof.");
  const cwd = path.join(root, "nested/deeper");
  await fs.mkdir(cwd, { recursive: true });
  const globals = { cwd, json: true };
  const parse = (result: { exitCode: number; stdout: string; stderr: string }) => {
    assert.equal(result.exitCode, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const cli = async (sub: string, args: string[]) =>
    parse(await runNodeCommand(sub, args, globals));
  const get = async (id: string) => (await cli("get", [id, "--full"])).node;
  return { root, globals, parse, cli, get };
}

test("cold-start material declarations share the Workspace root and detect subsequent drift", async (t) => {
  const { root, globals, parse, cli, get } = await fixture(t);
  const goal = (
    await cli("create", [
      "Nested goal",
      "--type",
      "goal",
      "--parent",
      "node-goal",
      "--sources-json",
      JSON.stringify([{ resource: "docs/req.md", title: "Requirements" }]),
      "--by",
      "process:review",
    ])
  ).node;
  assert.equal((await get(goal.nodeId)).sources[0].resource, "../../../docs/req.md");
  const card = parse(
    await runCardCommand(
      "create",
      ["--prompt", "Implement the goal", "--source", goal.nodeId],
      globals,
    ),
  );
  assert.equal(card.workspaceRoot, root);
  const taken = parse(await runCardCommand("take", [card.cardId], globals));
  assert.equal(taken.workspaceRoot, root);
  const linked = await cli("link-output", [
    goal.nodeId,
    "--resource",
    "/docs/proof.txt",
    "--card",
    card.cardId,
  ]);
  assert.equal(linked.workspaceRoot, root);
  assert.equal((await get(linked.nodeId)).resource, "../../../../docs/proof.txt");
  const explicit = (
    await cli("create", [
      "Explicit",
      "--type",
      "output",
      "--parent",
      goal.nodeId,
      "--resource",
      "./docs/proof.txt",
      "--sources-json",
      JSON.stringify([
        { resource: "/docs/req.md#Requirements" },
        { resource: "customer discussion" },
      ]),
    ])
  ).node;
  const saved = await get(explicit.nodeId);
  assert.equal(saved.resource, (await get(linked.nodeId)).resource);
  assert.deepEqual(saved.sources, [
    { resource: "../../../../docs/req.md#Requirements" },
    { resource: "customer discussion" },
  ]);
  assert.equal((await cli("search", ["--resource", "docs/proof.txt"])).items.length, 2);
  const checked = parse(await runWorkspaceCommand("check", [], globals));
  assert.deepEqual(checked.issues, []);
  assert.deepEqual(checked.errors, []);
  await fs.writeFile(path.join(root, "docs/req.md"), "# Requirements\nSecond.\n");
  assert.equal((await cli("check", [goal.nodeId])).state, "behind");
  const observed = await get(goal.nodeId);
  await cli("confirm", [goal.nodeId, "--base-etag", observed.etag, "--by", "human:reviewer"]);
  assert.equal(
    (await cli("check", [goal.nodeId])).state,
    "ahead",
    "confirming changed goal material leaves its existing outputs awaiting review",
  );
});

test("structured writes convert new material paths and preserve descriptors read from disk", async (t) => {
  const { root, cli, get } = await fixture(t);
  const created = (
    await cli("create", [
      "Note",
      "--type",
      "prompt",
      "--parent",
      "node-goal",
      "--resource",
      "docs/proof.txt",
    ])
  ).node;
  const initial = await get(created.nodeId);
  await cli("write", [
    created.nodeId,
    "--input-json",
    JSON.stringify({
      baseEtag: initial.etag,
      frontmatter: {
        resource: initial.resource,
        sources: [{ resource: "./docs/req.md", custom: { retain: true } }],
      },
    }),
  ]);
  const updated = await get(created.nodeId);
  assert.equal(updated.resource, initial.resource);
  assert.deepEqual(updated.sources, [
    { resource: "../../../docs/req.md", custom: { retain: true } },
  ]);
  await cli("write", [
    created.nodeId,
    "--input-json",
    JSON.stringify({
      baseEtag: updated.etag,
      frontmatter: { sources: updated.sources, description: "Preserve read-back paths" },
    }),
  ]);
  const retained = await get(created.nodeId);
  assert.deepEqual(retained.sources, updated.sources);
  const batch = await cli("write-many", [
    "--input-json",
    JSON.stringify({
      items: [
        {
          op: "create",
          ref: "child",
          parent: "@parent",
          name: "Batch Child",
          type: "output",
          resource: "/docs/proof.txt",
          sources: [{ resource: "docs/req.md" }, { resource: "@parent" }],
        },
        {
          op: "create",
          ref: "parent",
          name: "Batch Parent",
          type: "goal",
          sources: [{ resource: "./not-created-yet.txt" }],
        },
        {
          op: "update",
          nodeId: created.nodeId,
          baseEtag: retained.etag,
          frontmatter: { resource: "docs/req.md", sources: retained.sources },
        },
      ],
    }),
  ]);
  assert.equal(batch.workspaceRoot, root);
  const child = await get(batch.results[0].nodeId);
  assert.equal(child.path, "Batch Parent/Batch Child");
  assert.equal(child.resource, "../../../docs/proof.txt");
  assert.deepEqual(child.sources, [
    { resource: "../../../docs/req.md" },
    { resource: "../Batch%20Parent.md" },
  ]);
  assert.equal(
    (await get(batch.results[1].nodeId)).sources[0].resource,
    "../../not-created-yet.txt",
  );
  const final = await get(created.nodeId);
  assert.equal(final.resource, "../../../docs/req.md");
  assert.deepEqual(final.sources, retained.sources);
  const raw = serializeFrontmatter(
    { id: created.nodeId, type: "prompt", resource: "../../../docs/proof.txt" },
    "Raw bytes use stored addresses.",
  );
  await cli("write-many", [
    "--input-json",
    JSON.stringify({
      items: [{ op: "update", nodeId: created.nodeId, baseEtag: final.etag, raw }],
    }),
  ]);
  assert.equal((await get(created.nodeId)).resource, "../../../docs/proof.txt");
  const outside = await runNodeCommand(
    "create",
    ["Outside", "--type", "prompt", "--resource", "../outside.txt"],
    { workspace: root, json: true },
  );
  assert.equal(outside.exitCode, 1);
  assert.match(outside.stderr, /outside the Workspace/);
});

test("actor validation explains all formats without exposing a validation JSON dump", async (t) => {
  const { root, cli, get } = await fixture(t);
  for (const actor of ["human:reviewer", "process:import", "producer/1.0"])
    await cli("create", [actor.replace(/[/:]/g, "-"), "--type", "prompt", "--by", actor]);
  const result = await runNodeCommand(
    "create",
    ["Invalid", "--type", "prompt", "--by", "agent:judge"],
    { workspace: root },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, "--by must use human:<id>, process:<id>, or <producer>/<version>.\n");
  const goal = await get("node-goal");
  for (const [sub, input] of [
    ["write", { baseEtag: goal.etag, body: "Invalid", by: "agent:judge" }],
    [
      "write-many",
      {
        items: [
          { op: "create", ref: "invalid", name: "Invalid", type: "prompt", by: "agent:judge" },
        ],
      },
    ],
  ] as const) {
    const rejected = await runNodeCommand(
      sub,
      [...(sub === "write" ? ["node-goal"] : []), "--input-json", JSON.stringify(input)],
      { workspace: root },
    );
    assert.equal(
      rejected.stderr,
      "by must use human:<id>, process:<id>, or <producer>/<version>.\n",
    );
  }
  for (const sub of ["create", "write", "link-output", "confirm", "write-many"])
    assert.match(nodeHelpText(sub), /human:<id>, process:<id>, and <producer>\/<version>/);
});

test("successful mutation output identifies the resolved Workspace in human and JSON output", async (t) => {
  const { root, globals, parse } = await fixture(t);
  const created = await runNodeCommand("create", ["Human output", "--type", "prompt"], {
    cwd: globals.cwd,
  });
  assert.equal(created.exitCode, 0, created.stderr);
  assert.match(created.stdout, /\nWorkspace: /);
  assert.ok(created.stdout.includes(root));
  const role = parse(await runRoleCommand("create", ["--title", "Review"], globals));
  assert.equal(role.workspaceRoot, root);
  const roleRead = parse(await runRoleCommand("show", [role.roleId], globals));
  assert.equal("workspaceRoot" in roleRead, false);
  const nodeRead = parse(await runNodeCommand("get", ["node-goal", "--full"], globals));
  assert.equal("workspaceRoot" in nodeRead, false);
  assert.equal(
    parseFrontmatter(await fs.readFile(path.join(root, ".tent/Goal/Goal.md"), "utf8")).data
      .resource,
    undefined,
  );
});
