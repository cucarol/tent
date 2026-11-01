import { openTestFs, removeTestFixture } from "./node-fs.js";
import { testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { runNodeCommand, nodeHelpText } from "../src/cli/node-commands.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { parseFrontmatter } from "../src/core/base/frontmatter.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "cli-provenance-"));
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  await scaffoldInWorkspace(openTestFs(root), { name: "Actors", nodes: [] });
  await fs.writeFile(path.join(root, "proof.txt"), "Evidence.\n");
  const globals = { workspace: root, json: true };
  const run = async (command: string, args: string[], stdin?: string) => {
    const result = await runNodeCommand(command, args, { ...globals, stdin });
    assert.equal(result.exitCode, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const created = await run("create", [
    "Decision",
    "--id",
    "node-decision",
    "--type",
    "prompt",
    "--body",
    "## Choice\nFirst.\n",
  ]);
  const goal = await run("create", ["Goal", "--id", "node-goal", "--type", "goal"]);
  const document = path.join(root, ".tent/Decision/Decision.md");
  const data = async (relative = "Decision/Decision.md") =>
    parseFrontmatter(await fs.readFile(path.join(root, ".tent", relative), "utf8")).data;
  const etag = async () => (await run("get", [created.node.nodeId, "--full"])).etag;
  return {
    root,
    globals,
    run,
    document,
    data,
    etag,
    id: created.node.nodeId,
    goalId: goal.node.nodeId,
  };
}

test("ordinary CLI create, write, append, batch create and link-output do not generate provenance", async (t) => {
  const f = await fixture(t);
  assert.equal("generated" in (await f.data()), false);
  await f.run("write", [f.id, "--base-etag", await f.etag(), "--body", "## Choice\nSecond.\n"]);
  assert.equal("generated" in (await f.data()), false);
  await f.run("append", [f.id, "--heading", "Evidence", "--body", "Added."]);
  assert.equal("generated" in (await f.data()), false);
  await f.run("write", [
    f.id,
    "--input-json",
    JSON.stringify({
      baseEtag: await f.etag(),
      frontmatter: { tags: ["decision"] },
    }),
  ]);
  assert.equal("generated" in (await f.data()), false);
  await f.run(
    "write-many",
    ["--input-json", "-"],
    JSON.stringify({
      items: [
        { op: "create", ref: "another", name: "Another", type: "prompt", body: "Other." },
        { op: "update", nodeId: f.id, baseEtag: await f.etag(), body: "Batch." },
      ],
    }),
  );
  assert.equal("generated" in (await f.data("Another/Another.md")), false);
  assert.equal("generated" in (await f.data()), false);
  await f.run("link-output", [f.goalId, "--resource", "proof.txt", "--name", "Evidence"]);
  assert.equal("generated" in (await f.data("Goal/Evidence/Evidence.md")), false);
});

test("ordinary CLI by flags and unconfirmed JSON actors are rejected without changing documents", async (t) => {
  const f = await fixture(t);
  const etag = await f.etag();
  const files = ["Decision/Decision.md", "Goal/Goal.md", "order.json"];
  const before = await Promise.all(
    files.map((file) => fs.readFile(path.join(f.root, ".tent", file), "utf8")),
  );
  const topLevel: [string, string[]][] = [
    ["create", ["Unexpected", "--type", "prompt"]],
    ["write", [f.id, "--base-etag", etag, "--body", "Unexpected"]],
    ["append", [f.id, "--body", "Unexpected"]],
    ["link-output", [f.goalId, "--resource", "proof.txt", "--name", "Unexpected"]],
    [
      "write-many",
      [
        "--input-json",
        JSON.stringify({
          items: [{ op: "create", ref: "new", name: "Unexpected", type: "prompt" }],
        }),
      ],
    ],
    ["get", [f.id, "--full"]],
  ];
  for (const [command, args] of topLevel) {
    const result = await runNodeCommand(command, [...args, "--by", "human:cuca"], f.globals);
    assert.equal(result.exitCode, 1, command);
    assert.equal(
      result.stderr.split("\n")[0],
      "--by is only valid with node confirm or node write --confirm.",
    );
  }
  const jsonInputs: [string, string[], unknown][] = [
    ["write", [f.id], { baseEtag: etag, body: "Unexpected", by: "human:cuca" }],
    ["write", [f.id], { baseEtag: etag, body: "Unexpected", confirm: false, by: "human:cuca" }],
    [
      "write-many",
      [],
      {
        items: [
          { op: "create", ref: "new", name: "Unexpected", type: "prompt", by: "process:import" },
        ],
      },
    ],
    [
      "write-many",
      [],
      {
        items: [
          { op: "create", ref: "new", name: "Unexpected", type: "prompt" },
          { op: "update", nodeId: f.id, baseEtag: etag, body: "Unexpected", by: "process:review" },
        ],
      },
    ],
    [
      "write-many",
      [],
      {
        items: [
          {
            op: "update",
            nodeId: f.id,
            baseEtag: etag,
            body: "Unexpected",
            confirm: false,
            by: "process:review",
          },
        ],
      },
    ],
  ];
  for (const [command, args, input] of jsonInputs) {
    const result = await runNodeCommand(
      command,
      [...args, "--input-json", JSON.stringify(input)],
      f.globals,
    );
    assert.equal(result.exitCode, 1, JSON.stringify(input));
  }
  const after = await Promise.all(
    files.map((file) => fs.readFile(path.join(f.root, ".tent", file), "utf8")),
  );
  assert.deepEqual(after, before);
  for (const relative of ["Unexpected", "Goal/Unexpected"])
    await assert.rejects(fs.stat(path.join(f.root, ".tent", relative)), { code: "ENOENT" });
});

test("confirm and confirmed CLI writes record verified actors once across flags, JSON and batches", async (t) => {
  const f = await fixture(t);
  const actors = async () =>
    ((await f.data()).verified as { by: string }[]).map((entry) => entry.by).sort();
  for (let i = 0; i < 2; i++)
    await f.run("confirm", [f.id, "--base-etag", await f.etag(), "--by", "human:cuca"]);
  assert.deepEqual(await actors(), ["human:cuca"]);
  for (let i = 0; i < 2; i++)
    await f.run("write", [
      f.id,
      "--base-etag",
      await f.etag(),
      "--body",
      `Flag edit ${i}.`,
      "--confirm",
      "--by",
      "human:cuca",
    ]);
  assert.deepEqual(await actors(), ["human:cuca"]);
  for (let i = 0; i < 2; i++)
    await f.run(
      "write",
      [f.id, "--input-json", "-"],
      JSON.stringify({
        baseEtag: await f.etag(),
        body: `JSON edit ${i}.`,
        confirm: true,
        by: "process:review",
      }),
    );
  assert.deepEqual(await actors(), ["human:cuca", "process:review"]);
  for (const actor of ["process:review", "agent/batch-update", "agent/batch-update"])
    await f.run(
      "write-many",
      ["--input-json", "-"],
      JSON.stringify({
        items: [
          {
            op: "update",
            nodeId: f.id,
            baseEtag: await f.etag(),
            body: `Batch confirmed by ${actor}.`,
            confirm: true,
            by: actor,
          },
        ],
      }),
    );
  const data = await f.data();
  assert.equal("generated" in data, false);
  const verified = data.verified as { by: string; at: string }[];
  assert.deepEqual(verified.map((entry) => entry.by).sort(), [
    "agent/batch-update",
    "human:cuca",
    "process:review",
  ]);
  for (const entry of verified) assert.ok(Number.isFinite(Date.parse(entry.at)));
  assert.equal(
    parseFrontmatter(await fs.readFile(f.document, "utf8")).body,
    "Batch confirmed by agent/batch-update.",
  );
  const checked = await f.run("check", [f.id]);
  for (const field of ["trustTier", "stale", "archived"]) assert.equal(field in checked, false);
});

test("CLI restore has no command or help entry", async (t) => {
  const f = await fixture(t);
  const before = await fs.readFile(f.document, "utf8");
  const result = await runNodeCommand("restore", [f.id], f.globals);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Unknown command/);
  assert.doesNotMatch(nodeHelpText(), /\brestore\b/);
  assert.doesNotMatch(nodeHelpText("restore"), /\brestore\b/);
  assert.equal(await fs.readFile(f.document, "utf8"), before);
});
