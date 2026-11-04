import { openTestFs, removeTestFixture } from "./node-fs.js";
import { initializeFixtureHistory } from "./scratch.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { testScratchRoot, initializeFixtureWorkspace } from "./scratch.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { runCardCommand } from "../src/cli/card-commands.js";
import { runRoleCommand } from "../src/cli/role-commands.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { parseFrontmatter } from "../src/core/base/frontmatter.js";

async function fixture(t: TestContext) {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "cli-material-"));
  t.after(() =>
    removeTestFixture(root, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 200,
    }),
  );
  await scaffoldInWorkspace(root, {
    name: "CLI materials",
    nodes: [
      {
        id: "node-goal",
        name: "Goal",
        type: "goal",
        body: "Deliver evidence.",
      },
    ],
  });
  await initializeFixtureHistory(path.join(root, ".tent"));
  // Scaffolded Nodes start uncaptured; record them as Tent-created Nodes are.
  const adapter = openTestFs(path.join(root, ".tent"));
  await adapter.history.captureUnlocked([
    { path: "Goal/Goal.md", raw: await adapter.readFile("Goal/Goal.md") },
  ]);
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
  const paths = new Map<string, string>([["node-goal", ".tent/Goal/Goal.md"]]);
  const cli = async (sub: string, args: string[]) => {
    const result = parse(await runNodeCommand(sub, args, globals));
    if (result.node) paths.set(result.node.nodeId, result.node.path);
    return result;
  };
  const get = async (id: string) =>
    parseFrontmatter(await fs.readFile(path.join(root, paths.get(id)!), "utf8")).data;
  return { root, globals, parse, cli, get };
}

test("CLI material paths stay Workspace-rooted from different process working directories", async (t) => {
  const parent = await fs.mkdtemp(path.join(testScratchRoot(), "material-cwd-"));
  t.after(() =>
    removeTestFixture(parent, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 200,
    }),
  );
  const workspace = path.join(parent, "rich");
  const sibling = path.join(parent, "mapper-run");
  const nested = path.join(workspace, "nested");
  for (const directory of [path.join(workspace, "rich"), sibling, nested])
    await fs.mkdir(directory, { recursive: true });
  await initializeFixtureWorkspace(workspace);
  await fs.writeFile(path.join(workspace, "rich/console.py"), "# Width\nconsole = 1\n");
  const declaration = {
    resource: "./rich/console.py#Width",
    sources: [
      { resource: "./rich/console.*" },
      { resource: "rich/console.*" },
      { resource: "/rich/" },
    ],
  };
  const expected = {
    resource: "../../../rich/console.py#Width",
    sources: [
      { resource: "../../../rich/console.*" },
      { resource: "../../../rich/console.*" },
      { resource: "../../../rich/" },
    ],
  };
  const execute = promisify(execFile);
  const loader = import.meta.resolve("tsx");
  const document = "Rich library/Console/Console.md";
  const moduleUrl = new URL("../src/cli/material-input.ts", import.meta.url).href;
  const script = `import {workspaceMaterialFields} from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify(await workspaceMaterialFields(${JSON.stringify(declaration)}, ${JSON.stringify(document)}, ${JSON.stringify(workspace)})));`;
  for (const cwd of [workspace, nested, sibling]) {
    const { stdout } = await execute(
      process.execPath,
      ["--import", loader, "--input-type=module", "--eval", script],
      { cwd, windowsHide: true },
    );
    assert.deepEqual(JSON.parse(stdout), expected, `process cwd: ${cwd}`);
  }
});

test("cold-start creation normalizes explicit material paths under nested parents", async (t) => {
  const { root, globals, parse, cli, get } = await fixture(t);
  const goal = (
    await cli("create", [
      "Nested goal",
      "--type",
      "goal",
      "--parent",
      "node-goal",
      "--source",
      "docs/req.md",
    ])
  ).node;
  assert.deepEqual((await get(goal.nodeId)).sources, [{ resource: "../../../docs/req.md" }]);
  const explicit = (
    await cli("create", [
      "Explicit",
      "--type",
      "output",
      "--parent",
      goal.nodeId,
      "--resource",
      "./docs/proof.txt",
      "--source",
      "/docs/req.md#Requirements",
      "--source",
      "customer discussion",
    ])
  ).node;
  const saved = await get(explicit.nodeId);
  assert.equal(saved.resource, "../../../../docs/proof.txt");
  assert.deepEqual(saved.sources, [
    { resource: "../../../../docs/req.md#Requirements" },
    { resource: "customer discussion" },
  ]);
  const outside = await runNodeCommand(
    "create",
    ["Outside", "--type", "prompt", "--resource", "../outside.txt"],
    { workspace: root },
  );
  assert.equal(outside.exitCode, 1);
  assert.match(outside.stderr, /outside the Workspace/);
  const checked = parse(await runWorkspaceCommand("check", [], globals));
  assert.deepEqual(checked.issues, []);
  assert.deepEqual(checked.errors, []);
});

test("Card CLI file and Node sources are stored as Workspace-root addresses without versions", async (t) => {
  const { root, globals, parse } = await fixture(t);
  parse(await runRoleCommand("create", ["--id", "role-worker", "--title", "Worker"], globals));
  const sources = [
    "docs/req.md",
    "./docs/req.md",
    "/docs/req.md",
    "node-goal",
    ".tent/Goal/Goal.md",
  ];
  const card = parse(
    await runCardCommand(
      "create",
      [
        "--prompt",
        "Read the requirements.",
        "--target",
        "role-worker",
        ...sources.flatMap((source) => ["--source", source]),
      ],
      globals,
    ),
  );
  const stored = parseFrontmatter(
    await fs.readFile(path.join(root, ".tent/cards", `${card.cardId}.md`), "utf8"),
  ).data;
  assert.deepEqual(stored.sources, [
    { resource: "../../docs/req.md" },
    { resource: "../../docs/req.md" },
    { resource: "../../docs/req.md" },
    { resource: "../Goal/Goal.md" },
    { resource: "../Goal/Goal.md" },
  ]);
  const taken = parse(
    await runCardCommand("take", [card.cardId, "--role", "role-worker"], globals),
  );
  const requirement = {
    name: "docs/req.md",
    path: path.join(taken.workspaceRoot, "docs", "req.md"),
  };
  const goal = { name: "Goal", path: path.join(taken.workspaceRoot, ".tent", "Goal", "Goal.md") };
  assert.deepEqual(taken.sources, [requirement, requirement, requirement, goal, goal]);
  const checked = parse(await runWorkspaceCommand("check", [], { workspace: root, json: true }));
  assert.deepEqual(checked.issues, []);
  assert.deepEqual(checked.errors, []);
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
  assert.equal(
    parseFrontmatter(await fs.readFile(path.join(root, ".tent/Goal/Goal.md"), "utf8")).data
      .resource,
    undefined,
  );
});

test("Card response source roots match stored documents while ordinary CLI paths stay Workspace-rooted", async (t) => {
  const { root, globals, parse, cli, get } = await fixture(t);
  parse(await runRoleCommand("create", ["--id", "role-worker", "--title", "Worker"], globals));
  const card = parse(
    await runCardCommand(
      "create",
      ["--prompt", "Respond", "--source", "node-goal", "--target", "role-worker"],
      globals,
    ),
  );
  parse(await runCardCommand("take", [card.cardId, "--role", "role-worker"], globals));
  const created = (
    await cli("create", [
      "Manual response",
      "--type",
      "output",
      "--parent",
      "node-goal",
      "--source",
      `/cards/${card.cardId}.md`,
      "--source",
      "/docs/req.md",
    ])
  ).node;
  assert.deepEqual((await get(created.nodeId)).sources, [
    { resource: `/cards/${card.cardId}.md` },
    { resource: "../../../docs/req.md" },
  ]);
  const read = parseFrontmatter(
    await fs.readFile(path.join(root, ".tent/cards", `${card.cardId}.md`), "utf8"),
  ).data;
  assert.equal(read.state, "consumed");
  assert.equal("progress" in read, false);
  assert.equal("outputNodeIds" in read, false);
  await fs.mkdir(path.join(root, "cards"));
  await fs.writeFile(path.join(root, `cards/${card.cardId}.md`), "Workspace file");
  const ordinary = (
    await cli("create", ["Ordinary", "--type", "prompt", "--resource", `/cards/${card.cardId}.md`])
  ).node;
  assert.equal((await get(ordinary.nodeId)).resource, `../../cards/${card.cardId}.md`);
});
