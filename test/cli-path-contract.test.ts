import { openTestFs, removeTestFixture } from "./node-fs.js";
import { initializeFixtureHistory, initializeFixtureRepository } from "./scratch.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { cardHelpText, runCardCommand } from "../src/cli/card-commands.js";
import { runRoleCommand } from "../src/cli/role-commands.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { parseFrontmatter } from "../src/core/base/frontmatter.js";
import { materialLocator } from "../src/core/base/material.js";
import { testScratchRoot } from "./scratch.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "cli-path-contract-"));
  t.after(() =>
    removeTestFixture(root, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 200,
    }),
  );
  initializeFixtureRepository(root);
  await scaffoldInWorkspace(openTestFs(root), {
    name: "CLI path contract",
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
  await fs.mkdir(path.join(root, "docs"));
  await fs.writeFile(path.join(root, "docs/req.md"), "# Requirements\nFirst.\n");
  await fs.mkdir(path.join(root, "attachments"), { recursive: true });
  await fs.writeFile(path.join(root, "attachments/x.png"), "png");
  const cwd = path.join(root, "nested/deeper");
  await fs.mkdir(cwd, { recursive: true });
  const globals = { cwd, json: true };
  const text = { cwd };
  const parse = (result: { exitCode: number; stdout: string; stderr: string }) => {
    assert.equal(result.exitCode, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const stored = async (nodePath: string) =>
    parseFrontmatter(await fs.readFile(path.join(root, nodePath), "utf8")).data;
  parse(await runRoleCommand("create", ["--id", "role-worker", "--title", "Worker"], globals));
  const card = async (args: string[]) =>
    parse(await runCardCommand("create", ["--target", "role-worker", ...args], globals));
  const cardSources = async (cardId: string) =>
    (await stored(`.tent/cards/${cardId}.md`)).sources as Array<Record<string, unknown>>;
  return { root, globals, text, parse, stored, card, cardSources };
}

test("node create and card create resolve the same Workspace-root addresses", async (t) => {
  const { globals, parse, stored, card, cardSources } = await fixture(t);
  const cases = [
    [".tent/Goal/Goal.md", "Goal/Goal.md"],
    ["attachments/x.png", "../attachments/x.png"],
    ["docs/req.md", "../docs/req.md"],
    ["./docs/req.md", "../docs/req.md"],
    ["/docs/req.md", "../docs/req.md"],
    ["node-goal", "Goal/Goal.md"],
  ] as const;
  for (const [index, [input, target]] of cases.entries()) {
    const created = parse(
      await runNodeCommand(
        "create",
        [`Created ${index}`, "--type", "output", "--parent", "node-goal", "--resource", input],
        globals,
      ),
    ).node;
    const resource = (await stored(created.path)).resource as string;
    assert.equal(pathTarget(resource, created.path.replace(/^\.tent\//, "")), target, input);
  }
  const { cardId } = await card([
    "--prompt",
    "Read these.",
    ...cases.flatMap(([input]) => ["--source", input]),
  ]);
  for (const [index, source] of (await cardSources(cardId)).entries())
    assert.equal(
      pathTarget(source.resource as string, `cards/${cardId}.md`),
      cases[index]![1],
      cases[index]![0],
    );
});

test("card create warns about explicit path sources that name nothing and stores them unchanged", async (t) => {
  const { globals, cardSources } = await fixture(t);
  const sources = [
    "./docs/missing.md",
    "/docs/gone.md",
    "./docs/Missing/Missing.md",
    "docs/absent.md",
    "./docs/req.md",
    ".tent/Goal/Goal.md",
    "node-goal",
  ];
  const result = await runCardCommand(
    "create",
    [
      "--prompt",
      "Plan.",
      "--target",
      "role-worker",
      ...sources.flatMap((source) => ["--source", source]),
    ],
    globals,
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const card = JSON.parse(result.stdout);
  const warnings = result.stderr.trim().split("\n");
  assert.equal(warnings.length, 3, result.stderr);
  for (const [index, input] of [
    "./docs/missing.md",
    "/docs/gone.md",
    "./docs/Missing/Missing.md",
  ].entries())
    assert.match(warnings[index]!, new RegExp(`^Warning: source "${literal(input)}" names no `));
  assert.deepEqual(await cardSources(card.cardId), [
    { resource: "../../docs/missing.md" },
    { resource: "../../docs/gone.md" },
    { resource: "../../docs/Missing/Missing.md" },
    { resource: "docs/absent.md" },
    { resource: "../../docs/req.md" },
    { resource: "../Goal/Goal.md" },
    { resource: "../Goal/Goal.md" },
  ]);
});

test("card take prints the task and where each source is now, in text and JSON", async (t) => {
  const { root, globals, text, parse, card } = await fixture(t);
  const { cardId } = await card([
    "--prompt",
    "Implement.",
    "--source",
    "node-goal",
    "--source",
    "./docs/req.md",
    "--source",
    "./docs/missing.md",
    "--source",
    "customer discussion",
    "--source",
    "https://example.com/spec",
  ]);
  const taken = parse(await runCardCommand("take", [cardId, "--role", "role-worker"], globals));
  const workspace = taken.workspaceRoot as string;
  assert.equal(path.resolve(workspace), path.resolve(root));
  assert.equal(taken.text.trim(), "Implement.");
  assert.deepEqual(taken.sources, [
    { name: "Goal", path: path.join(workspace, ".tent", "Goal", "Goal.md") },
    { name: "docs/req.md", path: path.join(workspace, "docs", "req.md") },
    { name: "docs/missing.md", path: path.join(workspace, "docs", "missing.md"), missing: true },
    { name: "customer discussion" },
    { name: "https://example.com/spec" },
  ]);
  const replay = await runCardCommand("take", [cardId, "--role", "role-worker"], text);
  assert.equal(replay.exitCode, 0, replay.stderr);
  assert.ok(
    replay.stdout.endsWith(
      [
        "Implement.",
        "",
        "Sources:",
        `- Goal: ${path.join(workspace, ".tent", "Goal", "Goal.md")}`,
        `- docs/req.md: ${path.join(workspace, "docs", "req.md")}`,
        `- docs/missing.md: ${path.join(workspace, "docs", "missing.md")} (not found)`,
        "- customer discussion",
        "- https://example.com/spec",
        "",
      ].join("\n"),
    ),
    replay.stdout,
  );
});

test("card take marks a deleted source Node by its id, not the Node that took its path", async (t) => {
  const { globals, text, parse, card } = await fixture(t);
  const node = (name: string, id: string) =>
    runNodeCommand("create", [name, "--type", "goal", "--id", id, "--body", id], globals);
  parse(await node("Victim", "node-victim"));
  const { cardId } = await card(["--prompt", "Review.", "--source", "node-victim"]);
  parse(await runNodeCommand("delete", ["node-victim"], globals));
  parse(await node("Victim", "node-reused"));
  const taken = parse(await runCardCommand("take", [cardId, "--role", "role-worker"], globals));
  assert.deepEqual(taken.sources, [{ name: "node-victim", missing: true }]);
  const replay = await runCardCommand("take", [cardId, "--role", "role-worker"], text);
  assert.equal(replay.exitCode, 0, replay.stderr);
  assert.ok(replay.stdout.endsWith("Sources:\n- node-victim (not found)\n"), replay.stdout);
});

test("Card path help retains the Git Bash conversion guidance", () => {
  assert.match(cardHelpText(), /MSYS_NO_PATHCONV=1/);
});

test("role create prints one line and exposes its stored identity", async (t) => {
  const { globals, text, parse } = await fixture(t);
  const role = await runRoleCommand("create", ["--title", "Release"], text);
  assert.equal(role.exitCode, 0, role.stderr);
  const lines = role.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 2, role.stdout);
  const roleId = /^Created (role-[a-z0-9]+) {2}Release$/.exec(lines[0]!)?.[1];
  assert.ok(roleId, lines[0]);
  assert.equal(lines[1], `File: .tent/roles/${roleId}.md`);
  const roleJson = parse(await runRoleCommand("create", ["--title", "Review"], globals));
  assert.deepEqual(Object.keys(roleJson).sort(), ["path", "roleId", "version", "workspaceRoot"]);
});

function pathTarget(resource: string, documentPath: string) {
  const locator = materialLocator(resource, documentPath, true);
  assert.equal(locator.kind, "path", resource);
  return locator.kind === "path" ? locator.target : undefined;
}

function literal(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
