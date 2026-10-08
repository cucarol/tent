import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { parseFrontmatter } from "../src/core/frontmatter.js";
import { NodeFs } from "../src/fs/node-fs.js";

test("Node CLI forwards explicit actors through content writes, confirmation and batch inputs", async (t) => {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "cli-provenance-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await scaffoldInWorkspace(new NodeFs(root), { name: "Actors", nodes: [] });
  const globals = { workspace: root, json: true };
  const run = async (command: string, args: string[], stdin?: string) => {
    const result = await runNodeCommand(command, args, { ...globals, stdin });
    assert.equal(result.exitCode, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const created = await run("create", [
    "Decision",
    "--type",
    "prompt",
    "--body",
    "## Choice\nFirst.\n",
    "--by",
    "process:import",
  ]);
  const id = created.node.nodeId;
  const document = path.join(root, ".tent/Decision/Decision.md");
  const data = async (file = document) =>
    parseFrontmatter(await fs.readFile(file, "utf8")).data as {
      generated: { by: string; at: string };
      verified: { by: string; at: string }[];
    };
  const etag = async () => (await run("get", [id, "--full"])).node.etag;
  assert.equal((await data()).generated.by, "process:import");
  await run("write", [
    id,
    "--base-etag",
    await etag(),
    "--body",
    "## Choice\nSecond.\n",
    "--by",
    "agent/test",
  ]);
  assert.equal((await data()).generated.by, "agent/test");
  const generated = (await data()).generated;
  for (let i = 0; i < 2; i++)
    await run("confirm", [id, "--base-etag", await etag(), "--by", "human:cuca"]);
  const confirmed = await data();
  assert.deepEqual(confirmed.generated, generated);
  assert.equal(
    confirmed.verified.filter((entry: { by: string }) => entry.by === "human:cuca").length,
    1,
  );
  assert.equal((await run("check", [id])).trustTier, "human-reviewed");

  await run("append", [id, "--heading", "Evidence", "--body", "Added.", "--by", "agent/append"]);
  assert.equal((await data()).generated.by, "agent/append");
  const section = await run("get-section", [id, "--heading", "Evidence"]);
  await run("write-section", [
    id,
    "--heading",
    "Evidence",
    "--base-etag",
    section.sectionEtag,
    "--body",
    "## Evidence\nRevised.\n",
    "--by",
    "agent/section",
  ]);
  assert.equal((await data()).generated.by, "agent/section");
  await run("type", [id, "goal", "--base-etag", await etag(), "--by", "agent/type"]);
  assert.equal((await data()).generated.by, "agent/type");
  await run("tags", ["set", id, "reviewed", "--base-etag", await etag(), "--by", "agent/tags"]);
  assert.equal((await data()).generated.by, "agent/tags");
  await run(
    "write",
    [id, "--input-json", "-"],
    JSON.stringify({
      baseEtag: await etag(),
      body: "## Choice\nFinal.\n",
      confirm: true,
      by: "process:review",
    }),
  );
  const combined = await data();
  assert.equal(combined.generated.by, "process:review");
  assert.equal(
    combined.verified.filter((entry: { by: string }) => entry.by === "process:review").length,
    1,
  );
  await run(
    "write-many",
    ["--input-json", "-"],
    JSON.stringify({
      items: [
        {
          op: "create",
          ref: "another",
          name: "Another",
          type: "prompt",
          body: "Other.",
          by: "agent/batch-create",
        },
        {
          op: "update",
          nodeId: id,
          baseEtag: await etag(),
          body: "## Choice\nBatch.\n",
          confirm: true,
          by: "agent/batch-update",
        },
      ],
    }),
  );
  assert.equal((await data()).generated.by, "agent/batch-update");
  assert.equal(
    (await data(path.join(root, ".tent/Another/Another.md"))).generated.by,
    "agent/batch-create",
  );

  const before = await fs.readFile(document, "utf8");
  for (const [command, args] of [
    ["get", [id, "--full", "--by", "human:cuca"]],
    [
      "write",
      [
        id,
        "--input-json",
        JSON.stringify({ baseEtag: await etag(), body: "Unexpected" }),
        "--by",
        "human:cuca",
      ],
    ],
  ] as const) {
    const result = await runNodeCommand(command, [...args], globals);
    assert.equal(result.exitCode, 1);
  }
  assert.equal(await fs.readFile(document, "utf8"), before);
});
