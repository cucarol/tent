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
  return { root, globals, text, parse, stored };
}

test("node create and card create resolve the same Workspace-root addresses", async (t) => {
  const { globals, parse, stored } = await fixture(t);
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
  const card = parse(
    await runCardCommand(
      "create",
      ["--prompt", "Read these.", ...cases.flatMap(([input]) => ["--source", input])],
      globals,
    ),
  );
  const shown = parse(await runCardCommand("show", [card.cardId], globals));
  for (const [index, source] of (shown.sources as Array<{ resource: string }>).entries())
    assert.equal(
      pathTarget(source.resource, `cards/${card.cardId}.md`),
      cases[index]![1],
      cases[index]![0],
    );
});

test("card create warns about explicit path sources that name nothing and stores them unchanged", async (t) => {
  const { globals, parse } = await fixture(t);
  const sources = [
    "./docs/missing.md",
    "/docs/gone.md",
    "./docs/Missing/Missing.md",
    "docs/absent.md",
    "./docs/req.md",
    ".tent/Goal/Goal.md",
    "node-goal",
    JSON.stringify({ resource: "./docs/json-missing.md", title: "Planned" }),
  ];
  const result = await runCardCommand(
    "create",
    ["--prompt", "Plan.", ...sources.flatMap((source) => ["--source", source])],
    globals,
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const card = JSON.parse(result.stdout);
  const warnings = result.stderr.trim().split("\n");
  assert.equal(warnings.length, 4, result.stderr);
  for (const [index, input] of [
    "./docs/missing.md",
    "/docs/gone.md",
    "./docs/Missing/Missing.md",
    "./docs/json-missing.md",
  ].entries())
    assert.match(warnings[index]!, new RegExp(`^Warning: source "${literal(input)}" names no `));
  const shown = parse(await runCardCommand("show", [card.cardId], globals));
  assert.deepEqual(
    (shown.sources as Array<Record<string, unknown>>).map(
      ({ version: _version, path: _path, ...source }) => source,
    ),
    [
      { resource: "../../docs/missing.md" },
      { resource: "../../docs/gone.md" },
      { resource: "../../docs/Missing/Missing.md" },
      { resource: "docs/absent.md" },
      { resource: "../../docs/req.md" },
      { resource: "../Goal/Goal.md" },
      { resource: "../Goal/Goal.md" },
      { resource: "../../docs/json-missing.md", title: "Planned" },
    ],
  );
});

test("card show and take list sources in text while JSON output keeps its fields", async (t) => {
  const { globals, text, parse } = await fixture(t);
  const card = parse(
    await runCardCommand(
      "create",
      [
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
      ],
      globals,
    ),
  );
  const json = parse(await runCardCommand("show", [card.cardId], globals));
  assert.equal("sourceDetails" in json, false);
  const commit = (json.sources[0].version.commit as string).slice(0, 7);
  const expected = [
    "Sources:",
    `  1. .tent/Goal/Goal.md  Node Goal  node-goal  @${commit}`,
    "  2. docs/req.md  file exists",
    "  3. docs/missing.md  file missing",
    "  4. customer discussion  description text",
    "  5. https://example.com/spec  remote address, not fetched",
  ].join("\n");
  for (const sub of ["show", "take"]) {
    const result = await runCardCommand(sub, [card.cardId], text);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(result.stdout.includes(expected), `${sub}:\n${result.stdout}`);
  }
  const shownAgain = parse(await runCardCommand("show", [card.cardId], globals));
  assert.deepEqual(shownAgain.sources, json.sources);
});

test("Card path help retains the Git Bash conversion guidance", () => {
  assert.match(cardHelpText(), /MSYS_NO_PATHCONV=1/);
});

test("role create prints one line and exposes its stored identity", async (t) => {
  const { root, globals, text, parse } = await fixture(t);
  const role = await runRoleCommand("create", ["--title", "Release"], text);
  assert.equal(role.exitCode, 0, role.stderr);
  const lines = role.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 2, role.stdout);
  assert.match(lines[0]!, /^Created role-[a-z0-9]+ {2}Release$/);
  assert.equal(lines[1], `Workspace: ${root}`);
  const roleJson = parse(await runRoleCommand("create", ["--title", "Review"], globals));
  assert.deepEqual(Object.keys(roleJson).sort(), [
    "changed",
    "etag",
    "path",
    "roleId",
    "version",
    "workspaceRoot",
  ]);
});

function pathTarget(resource: string, documentPath: string) {
  const locator = materialLocator(resource, documentPath, true);
  assert.equal(locator.kind, "path", resource);
  return locator.kind === "path" ? locator.target : undefined;
}

function literal(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
