import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runCardCommand } from "../src/cli/card-commands.js";
import { nodeHelpText, runNodeCommand } from "../src/cli/node-commands.js";
import { runRoleCommand } from "../src/cli/role-commands.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { git } from "./helpers.js";
import { NodeFs } from "../src/fs/node-fs.js";

test("Node help is offline and does not parse or read requested content", async () => {
  const globals = { workspace: path.resolve(".scratch/missing-help-workspace") };
  for (const [sub, args] of [
    ["help", []],
    ["--help", []],
    ["-h", []],
    ["write", ["--help", "--input-json", "-"]],
    ["create", ["-h", "--sources-json", "unfinished"]],
    ["get", ["--help"]],
  ] as Array<[string, string[]]>) {
    const result = await runNodeCommand(sub, args, globals);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, nodeHelpText(sub));
    if (sub === "create") {
      assert.match(result.stdout, /--sources-json/);
      assert.doesNotMatch(result.stdout, /tent node (write|delete|get)/);
    }
    if (sub === "get") assert.doesNotMatch(result.stdout, /Write JSON|base-etag|tent node create/);
  }
  assert.equal((await runNodeCommand("fork", ["node-unused"], globals)).exitCode, 1);
});

test("CLI manages Workspace objects directly and preserves CAS", async () => {
  const scratch = path.resolve(".scratch");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "cli-workspace-tools-"));
  const workspace = path.join(root, "workspace");
  await scaffoldInWorkspace(new NodeFs(workspace), {
    name: "CLI tools",
    nodes: [{ id: "node-fact", name: "Fact", type: "prompt", body: "Original fact" }],
  });
  try {
    const globals = { workspace, json: true };
    const result = (value: { exitCode: number; stdout: string; stderr: string }) => {
      assert.equal(value.exitCode, 0, value.stderr);
      return JSON.parse(value.stdout);
    };
    const refs = [
      { resource: "/refs/example.pdf", title: "first" },
      { resource: "/refs/example.pdf", custom: [2, 1] },
    ];
    const note = result(
      await runNodeCommand(
        "create",
        [
          "CLI Note",
          "--type",
          "prompt",
          "--body",
          "Independent Markdown",
          "--sources-json",
          JSON.stringify(refs),
        ],
        globals,
      ),
    ).node;
    const saved = result(await runNodeCommand("get", [note.nodeId, "--full"], globals)).node;
    assert.equal(saved.text, "Independent Markdown\n");
    assert.deepEqual(
      saved.sources,
      refs.map((source) => ({ ...source, resource: "../../refs/example.pdf" })),
    );
    assert.equal(
      (
        await runNodeCommand(
          "create",
          [
            "Invalid refs",
            "--type",
            "prompt",
            "--sources-json",
            JSON.stringify([{ resource: "" }]),
          ],
          globals,
        )
      ).exitCode,
      1,
    );
    assert.equal(await new NodeFs(path.join(workspace, ".tent")).exists("Invalid refs"), false);
    assert.equal((await runNodeCommand("fork", ["node-fact"], globals)).exitCode, 1);
    assert.equal(
      result(await runNodeCommand("search", ["Original fact"], globals)).items.length,
      1,
    );
    assert.deepEqual(result(await runNodeCommand("backlinks", ["node-fact"], globals)).items, []);
    const readFact = async () =>
      result(await runNodeCommand("get", ["node-fact", "--full"], globals)).node;
    const observed = await readFact();
    result(
      await runNodeCommand(
        "write",
        ["node-fact", "--body", "Another writer's fact", "--base-etag", observed.etag],
        globals,
      ),
    );
    const concurrent = await readFact();
    for (const [command, args] of [
      ["type", ["node-fact", "output"]],
      ["tags", ["set", "node-fact", "new"]],
      ["tags", ["add", "node-fact", "new"]],
      ["tags", ["remove", "node-fact", "old"]],
    ] as const) {
      const staleEdit = await runNodeCommand(
        command,
        [...args, "--base-etag", observed.etag],
        globals,
      );
      assert.equal(staleEdit.exitCode, 1, `${command} must reject the stale observation`);
      assert.match(staleEdit.stderr, /conflict|etag/i);
      assert.deepEqual(await readFact(), concurrent);
      assert.equal((await runNodeCommand(command, [...args], globals)).exitCode, 1);
    }
    result(
      await runNodeCommand(
        "type",
        ["node-fact", "output", "--base-etag", concurrent.etag],
        globals,
      ),
    );
    assert.equal((await readFact()).type, "output");
    for (const [action, values, expected] of [
      ["set", "alpha,beta", ["alpha", "beta"]],
      ["add", "beta,gamma", ["alpha", "beta", "gamma"]],
      ["remove", "alpha,gamma", ["beta"]],
      ["set", "", []],
    ] as const) {
      result(
        await runNodeCommand(
          "tags",
          [action, "node-fact", values, "--base-etag", (await readFact()).etag],
          globals,
        ),
      );
      assert.deepEqual((await readFact()).tags, expected);
    }
    await git(path.join(workspace, ".tent"), "init");
    const source = { resource: "./refs/example.pdf", title: "Reference document" };
    const input = result(
      await runCardCommand(
        "create",
        ["--source", ".tent/Fact/Fact.md", "--source", JSON.stringify(source)],
        globals,
      ),
    );
    const savedInput = result(await runCardCommand("get", [input.cardId], globals));
    assert.equal(savedInput.sources[0].resource, "../Fact/Fact.md");
    assert.equal(savedInput.sources[0].version.path, "Fact/Fact.md");
    assert.deepEqual(savedInput.sources[1], { ...source, resource: "../../refs/example.pdf" });
    const invalid = await runCardCommand(
      "create",
      ["--source", JSON.stringify({ resource: "" })],
      globals,
    );
    assert.equal(invalid.exitCode, 1);
    const created = result(await runRoleCommand("create", ["--title", "Reviewer"], globals));
    const roleId = created.roleId;
    const before = result(await runRoleCommand("show", [roleId], globals));
    result(
      await runRoleCommand("write", [roleId, "--body", "-", "--base-etag", before.etag], {
        ...globals,
        stdin: "Review the facts.\n",
      }),
    );
    const after = result(await runRoleCommand("show", [roleId], globals));
    assert.equal(after.text, "Review the facts.\n");
    const stale = await runRoleCommand(
      "write",
      [roleId, "--body", "Stale", "--base-etag", before.etag],
      globals,
    );
    assert.equal(stale.exitCode, 1);
    assert.equal(result(await runRoleCommand("show", [roleId], globals)).etag, after.etag);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
});
