import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { nodeHelpText, runNodeCommand } from "../src/cli/node-commands.js";
import { runRoleCommand } from "../src/cli/role-commands.js";
import { runCardCommand } from "../src/cli/card-commands.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { NodeFs, SystemClock } from "../src/fs/node-fs.js";
import { parseFrontmatter } from "../src/core/frontmatter.js";
import { moveNode } from "../src/core/move-ops.js";
import { readNode, listNodes } from "../src/core/node-query.js";
import { git } from "./helpers.js";

async function fixture(t: { after(fn: () => Promise<void>): void }, name: string) {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, name));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await scaffoldInWorkspace(new NodeFs(root), {
    name,
    nodes: [
      { id: "node-parent", name: "Parent", type: "goal", body: "parent" },
      { id: "node-other", name: "Other", type: "prompt", body: "unselected-body" },
    ],
  });
  const tent = new NodeFs(path.join(root, ".tent"));
  const parse = (result: { exitCode: number; stdout: string; stderr: string }) => {
    assert.equal(result.exitCode, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const cli = async (sub: string, args: string[], stdin?: string) =>
    parse(await runNodeCommand(sub, args, { workspace: root, json: true, stdin }));
  return { root, tent, cli, parse };
}

test("Node, Role, Card and batch reads use text for body and raw content without a body alias", async (t) => {
  const { root, cli, parse } = await fixture(t, "uniform-reader-text-");
  await git(path.join(root, ".tent"), "init");
  const globals = { workspace: root, json: true };
  const role = parse(
    await runRoleCommand("create", ["--title", "Reader", "--body", "role body"], globals),
  );
  const card = parse(await runCardCommand("create", ["--prompt", "card body"], globals));
  const assertText = (value: Record<string, unknown>, expected: string, raw: boolean) => {
    assert.equal(typeof value.text, "string");
    assert.equal("body" in value, false);
    if (raw) {
      assert.match(value.text as string, /^---/);
      assert.ok((value.text as string).endsWith(expected));
    } else assert.equal(value.text, expected);
  };
  for (const view of ["body", "raw"]) {
    for (const full of [[], ["--full"]])
      assertText(
        (await cli("get", ["node-parent", "--view", view, ...full])).node,
        "parent",
        view === "raw",
      );
    const batch = await cli("read-many", ["node-parent", "node-other", "--view", view]);
    assertText(batch.items[0], "parent", view === "raw");
    assertText(batch.items[1], "unselected-body", view === "raw");
    assertText(
      parse(await runRoleCommand("show", [role.roleId, "--view", view], globals)),
      "role body",
      view === "raw",
    );
    assertText(
      parse(await runCardCommand("show", [card.cardId, "--view", view], globals)),
      "card body",
      view === "raw",
    );
  }
  const fullTree = await cli("list", ["--full"]);
  assertText(
    fullTree.nodes.find((node: { nodeId: string }) => node.nodeId === "node-parent"),
    "parent",
    false,
  );
});

test("direct Node CLI creates standard materials and uses observed CAS for metadata and structure", async (t) => {
  const { root, tent, cli } = await fixture(t, "direct-node-");
  const sources = [
    { resource: "./spec.md", custom: { order: [2, 1] } },
    { resource: "customer discussion" },
  ];
  const created = (
    await cli(
      "create",
      [
        "Child",
        "--parent",
        "node-parent",
        "--type",
        "output-proof",
        "--body",
        "-",
        "--resource",
        "src/main.ts",
        "--sources-json",
        JSON.stringify(sources),
        "--tags",
        "scope,proof",
      ],
      "exact body\n",
    )
  ).node;
  const id = created.nodeId;
  const old = (await cli("get", [id, "--full"])).node;
  assert.equal(old.path, "Parent/Child");
  assert.equal(old.text, "exact body\n");
  assert.equal("body" in old, false);
  assert.deepEqual(old.sources, [{ ...sources[0], resource: "../../../spec.md" }, sources[1]]);
  const saved = await cli(
    "write",
    [id, "--input-json", "-"],
    JSON.stringify({
      baseEtag: old.etag,
      body: "external update",
      frontmatter: { description: "visible summary", custom: [3, 2, 1] },
      readBack: true,
    }),
  );
  assert.equal(saved.readBack.text, "external update");
  for (const [sub, args] of [
    ["write", [id, "--body", "stale", "--base-etag", old.etag]],
    ["type", [id, "prompt", "--base-etag", old.etag]],
    ["tags", ["set", id, "lost", "--base-etag", old.etag]],
  ] as const) {
    const rejected = await runNodeCommand(sub, [...args], { workspace: root });
    assert.equal(rejected.exitCode, 1);
    assert.match(rejected.stderr, /conflict|etag/i);
  }
  assert.deepEqual(
    parseFrontmatter(await tent.readFile("Parent/Child/Child.md")).data.custom,
    [3, 2, 1],
  );
  await cli("tags", ["add", id, "kept", "--base-etag", saved.etag]);
  assert.deepEqual((await cli("get", [id, "--full"])).node.tags, ["kept", "proof", "scope"]);
  const tree = await cli("list", ["--full"]);
  assert.equal(
    tree.nodes.find((n: { nodeId: string }) => n.nodeId === "node-parent").children[0].text,
    "external update",
  );
  await cli("rename", [id, "Renamed"]);
  const env = {
    fs: tent,
    clock: new SystemClock(),
    tentName: "test",
    tentRoot: path.join(root, ".tent"),
  };
  await assert.rejects(moveNode(env, id, null, { mode: "inside" }, "Parent/Child"), /path changed/);
  await cli("move", [id, "--parent", "root"]);
  assert.equal((await cli("get", [id, "--full"])).node.path, "Renamed");
  await cli("delete", [id]);
  assert.equal(await tent.exists("Renamed"), false);
  for (const args of [["--attach-only"], ["--service-entry", "unused"], ["--data-dir", "unused"]]) {
    const rejected = await runNodeCommand("list", args, { workspace: root });
    assert.equal(rejected.exitCode, 1);
    assert.match(rejected.stderr, /Unknown option/);
  }
  assert.match(nodeHelpText(), /direct Core/);
  assert.doesNotMatch(nodeHelpText(), /Service-backed|Local Service/);
});

test("direct selected queries read headers elsewhere, retain selected bytes and never resume pending mutations", async (t) => {
  const { root, tent } = await fixture(t, "direct-query-");
  await git(path.join(root, ".tent"), "init");
  await tent.writeFile("node-move.pending.json", "broken pending operation");
  const bodyReads: string[] = [];
  const observed = new Proxy(tent, {
    get(target, key) {
      if (key === "readFile")
        return async (file: string) => {
          if (file.endsWith(".md")) bodyReads.push(file);
          if (file === "Other/Other.md") throw new Error("unrelated body was read");
          return target.readFile(file);
        };
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await listNodes(observed, "ws-test", {});
  await readNode(observed, "ws-test", { nodeId: "node-parent", view: "summary" });
  assert.deepEqual(bodyReads, []);
  const read = (await readNode(observed, "ws-test", { nodeId: "node-parent", capture: true })).node;
  assert.ok("text" in read);
  assert.equal(read.text, "parent");
  assert.deepEqual(bodyReads, ["Parent/Parent.md"]);
  assert.deepEqual(
    (await git(path.join(root, ".tent"), "ls-tree", "-r", "--name-only", "HEAD"))
      .trim()
      .split("\n"),
    ["Parent/Parent.md"],
  );
  assert.equal(await tent.readFile("node-move.pending.json"), "broken pending operation");
});

test("separate direct CLI processes retain Git versions and reject a stale edit without a Service", async (t) => {
  const { root, tent, parse } = await fixture(t, "direct-node-process-");
  await git(path.join(root, ".tent"), "init");
  const cli = (sub: string, args: string[]) =>
    new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          path.resolve("src/cli/tent.ts"),
          "node",
          sub,
          "--workspace",
          root,
          "--json",
          ...args,
        ],
        {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            TENT_SERVICE_ENTRY: "must-not-run",
            TENT_SERVICE_DATA_DIR: path.join(root, "absent-service"),
          },
        },
      );
      let stdout = "",
        stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    });
  const before = parse(await cli("get", ["node-parent", "--full"])).node;
  assert.ok(before.version.commit);
  const saved = parse(
    await cli("write", ["node-parent", "--body", "next", "--base-etag", before.etag]),
  );
  assert.ok(saved.version.commit);
  assert.notEqual(saved.version.commit, before.version.commit);
  const history = parse(await cli("history", ["node-parent"]));
  assert.ok(history.items.some((item: { changes: unknown[] }) => item.changes.length > 0));
  const stale = await cli("write", ["node-parent", "--body", "lost", "--base-etag", before.etag]);
  assert.equal(stale.exitCode, 1);
  assert.match(stale.stderr, /conflict/i);
  const prior = parse(
    await cli("get", ["node-parent", "--version-json", JSON.stringify(before.version)]),
  );
  assert.equal(prior.node.text, "parent");
  const archive = parse(await cli("archive", ["node-parent"]));
  assert.equal(parseFrontmatter(await tent.readFile("Parent/Parent.md")).data.status, "deprecated");
  parse(await cli("restore", ["node-parent", "--archive-commit", archive.commit]));
  assert.equal(parseFrontmatter(await tent.readFile("Parent/Parent.md")).data.status, undefined);
  assert.equal(parseFrontmatter(await tent.readFile("Parent/Parent.md")).body, "next");
  await assert.rejects(fs.stat(path.join(root, "absent-service")), { code: "ENOENT" });
});
