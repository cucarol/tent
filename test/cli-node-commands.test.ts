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
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
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
        await cli("get", ["node-parent", "--view", view, ...full]),
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
        "output",
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
  const old = await cli("get", [id, "--full"]);
  assert.equal(created.path, ".tent/Parent/Child/Child.md");
  assert.equal(old.text, "exact body\n");
  assert.equal("body" in old, false);
  assert.deepEqual(parseFrontmatter(await tent.readFile("Parent/Child/Child.md")).data.sources, [
    { ...sources[0], resource: "../../../spec.md" },
    sources[1],
  ]);
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
  assert.equal(saved.path, created.path);
  assert.equal(saved.readBack.path, created.path);
  assert.equal(
    parseFrontmatter(await fs.readFile(path.join(root, saved.path), "utf8")).body,
    saved.readBack.text,
  );
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
  assert.deepEqual((await cli("get", [id, "--view", "summary"])).tags, ["kept", "proof", "scope"]);
  const tree = await cli("list", ["--full"]);
  assert.equal(
    tree.nodes.find((n: { nodeId: string }) => n.nodeId === "node-parent").children[0].text,
    "external update",
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    const renamed = await cli("rename", [id, "Renamed"]);
    assert.equal(renamed.path, ".tent/Parent/Renamed/Renamed.md");
    assert.equal(
      parseFrontmatter(await fs.readFile(path.join(root, renamed.path), "utf8")).body,
      "external update",
    );
  }
  const env = {
    fs: tent,
    clock: new SystemClock(),
    tentName: "test",
    tentRoot: path.join(root, ".tent"),
  };
  await assert.rejects(moveNode(env, id, null, { mode: "inside" }, "Parent/Child"), /path changed/);
  for (let attempt = 0; attempt < 2; attempt++) {
    const moved = await cli("move", [id, "--parent", "root"]);
    assert.equal(moved.path, ".tent/Renamed/Renamed.md");
    assert.equal(
      parseFrontmatter(await fs.readFile(path.join(root, moved.path), "utf8")).body,
      "external update",
    );
  }
  assert.equal((await cli("get", [id, "--view", "summary"])).path, ".tent/Renamed/Renamed.md");
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
  const before = parse(await cli("get", ["node-parent", "--full"]));
  const beforeVersion = (
    await tent.history.captureUnlocked(
      [{ path: "Parent/Parent.md", raw: await tent.readFile("Parent/Parent.md") }],
      { operation: "test.fixture" },
    )
  ).versions[0];
  assert.equal("version" in before, false);
  const saved = parse(
    await cli("write", ["node-parent", "--body", "next", "--base-etag", before.etag]),
  );
  assert.ok(saved.version.commit);
  assert.notEqual(saved.version.commit, beforeVersion!.commit);
  const history = parse(await cli("history", ["node-parent"]));
  assert.ok(history.items.some((item: { changes: unknown[] }) => item.changes.length > 0));
  const stale = await cli("write", ["node-parent", "--body", "lost", "--base-etag", before.etag]);
  assert.equal(stale.exitCode, 1);
  assert.match(stale.stderr, /conflict/i);
  const prior = parse(
    await cli("get", ["node-parent", "--version-json", JSON.stringify(beforeVersion)]),
  );
  assert.equal(prior.text, "parent");
  const archive = parse(await cli("archive", ["node-parent"]));
  assert.equal(parseFrontmatter(await tent.readFile("Parent/Parent.md")).data.status, "deprecated");
  parse(await cli("restore", ["node-parent", "--archive-commit", archive.commit]));
  assert.equal(parseFrontmatter(await tent.readFile("Parent/Parent.md")).data.status, undefined);
  assert.equal(parseFrontmatter(await tent.readFile("Parent/Parent.md")).body, "next");
  await assert.rejects(fs.stat(path.join(root, "absent-service")), { code: "ENOENT" });
});

test("node list filters exact types and every tag across a subtree, with paging and archives", async (t) => {
  const { root, cli } = await fixture(t, "list-filters-");
  const make = async (name: string, type: string, parent: string, tags = "") =>
    (
      await cli("create", [
        name,
        "--type",
        type,
        "--parent",
        parent,
        ...(tags ? ["--tags", tags] : []),
      ])
    ).node.nodeId as string;
  const evidence = await make("Evidence", "output", "node-parent", "evidence,ui");
  const issue = await make("Issue", "output", "node-parent", "issue,ui");
  const decision = await make("Decision", "prompt", "node-parent", "decision");
  const nested = await make("Nested", "goal", "node-parent");
  const deep = await make("Deep", "output", nested, "evidence");
  const old = await make("Old", "output", "node-other", "evidence,legacy");
  const read = await cli("get", [old, "--full"]);
  await cli(
    "write",
    [old, "--input-json", "-"],
    JSON.stringify({ baseEtag: read.etag, frontmatter: { status: "deprecated" } }),
  );
  const ids = async (...args: string[]) =>
    (await cli("list", args)).items.map((item: { nodeId: string }) => item.nodeId);

  assert.deepEqual(
    await ids("--parent", "node-parent"),
    [evidence, issue, decision, nested],
    "without filters only direct children are listed",
  );
  assert.deepEqual(await ids("--type", "output"), [evidence, issue, deep]);
  assert.deepEqual(await ids("--tag", "ui"), [evidence, issue]);
  assert.deepEqual(await ids("--tag", "evidence", "--tag", "ui"), [evidence]);
  assert.deepEqual(await ids("--type", "output", "--tag", "evidence"), [evidence, deep]);
  assert.deepEqual(
    (await ids("--tag", "evidence", "--include-archived")).sort(),
    [deep, evidence, old].sort(),
  );
  assert.deepEqual(await ids("--parent", nested, "--type", "output"), [deep]);
  assert.deepEqual(await ids("--type", "prompt", "--tag", "decision"), [decision]);
  assert.deepEqual(await ids("--type", "goal", "--tag", "ui"), []);
  const first = await cli("list", ["--type", "output", "--limit", "1"]);
  assert.deepEqual(first.scope, { parentNodeId: null, includeArchived: false, type: "output" });
  assert.equal(first.items[0].nodeId, evidence);
  const second = await cli("list", [
    "--type",
    "output",
    "--limit",
    "1",
    "--cursor",
    first.page.nextCursor,
  ]);
  assert.equal(second.items[0].nodeId, issue);

  for (const [args, message] of [
    [["--type", "output-evidence"], "--type must be goal, prompt or output.\n"],
    [["--type", "Output"], "--type must be goal, prompt or output.\n"],
    [["--full", "--type", "output"], "--full cannot be combined with reader filters or paging.\n"],
    [["--full", "--tag", "ui"], "--full cannot be combined with reader filters or paging.\n"],
  ] as const) {
    const rejected = await runNodeCommand("list", [...args], { workspace: root });
    assert.equal(rejected.exitCode, 1);
    assert.equal(rejected.stderr, message + "Next: tent node --help\n");
  }
  const misplaced = await runNodeCommand("get", [evidence, "--tag", "ui"], { workspace: root });
  assert.equal(misplaced.exitCode, 1);
  assert.equal(misplaced.stderr, "--tag is only valid for node list\nNext: tent node --help\n");
});

test("every tag node tags counts can select its Node in node list", async (t) => {
  const { tent, cli } = await fixture(t, "tag-filter-normalized-");
  await tent.mkdir("Padded");
  await tent.writeFile(
    "Padded/Padded.md",
    '---\nid: node-padded\ntype: prompt\ntags: ["  evidence  ", analysis, "  "]\n---\nhand-written\n',
  );
  assert.deepEqual((await cli("tags", [])).tags, [
    { tag: "analysis", count: 1, preset: true },
    { tag: "evidence", count: 1, preset: true },
  ]);
  for (const tag of ["evidence", "  evidence  "]) {
    const listed = await cli("list", ["--tag", tag]);
    assert.deepEqual(
      listed.items.map((item: { nodeId: string; tags: string[] }) => [item.nodeId, item.tags]),
      [["node-padded", ["evidence", "analysis"]]],
      JSON.stringify(tag),
    );
  }
});

test("node tags lists tags in use with counts and preset marks; types accept exactly three values", async (t) => {
  const { root, cli } = await fixture(t, "tag-counts-");
  for (const [name, tags] of [
    ["A", "evidence,ui"],
    ["B", "ui,evidence"],
    ["C", "decision"],
    ["D", "issue"],
  ])
    await cli("create", [name, "--type", "output", "--tags", tags]);
  const old = (await cli("create", ["Old", "--type", "output", "--tags", "legacy,evidence"])).node
    .nodeId;
  const read = await cli("get", [old, "--full"]);
  await cli(
    "write",
    [old, "--input-json", "-"],
    JSON.stringify({ baseEtag: read.etag, frontmatter: { status: "deprecated" } }),
  );
  const presets = [
    "direction",
    "requirement",
    "decision",
    "spec",
    "reference",
    "procedure",
    "asset",
    "evidence",
    "analysis",
    "issue",
  ];
  const listed = await cli("tags", []);
  assert.deepEqual(listed.tags, [
    { tag: "evidence", count: 2, preset: true },
    { tag: "ui", count: 2, preset: false },
    { tag: "decision", count: 1, preset: true },
    { tag: "issue", count: 1, preset: true },
  ]);
  assert.deepEqual(listed.presets, presets);
  assert.deepEqual((await cli("tags", ["--include-archived"])).tags.slice(0, 2), [
    { tag: "evidence", count: 3, preset: true },
    { tag: "ui", count: 2, preset: false },
  ]);
  const text = await runNodeCommand("tags", [], { workspace: root });
  assert.equal(text.exitCode, 0, text.stderr);
  assert.equal(
    text.stdout,
    [
      "2  evidence  (preset)",
      "2  ui",
      "1  decision  (preset)",
      "1  issue  (preset)",
      `Presets: ${presets.join(", ")}`,
      "",
    ].join("\n"),
  );
  const rejectedTags = await runNodeCommand("tags", ["--limit", "2"], { workspace: root });
  assert.equal(rejectedTags.exitCode, 1);

  const created = await runNodeCommand("create", ["Bad", "--type", "output-asset"], {
    workspace: root,
  });
  assert.equal(created.exitCode, 1);
  assert.equal(created.stderr.split("\n")[0], "Node type must be goal, prompt or output.");
  assert.match(
    created.stderr.split("\n").slice(1).join("\n"),
    /^Next: tent node create --help --workspace .+  # words like decision or evidence go in --tags\n$/,
  );
  const target = (await cli("create", ["Typed", "--type", "prompt"])).node;
  const changed = await runNodeCommand(
    "type",
    [target.nodeId, "prompt-decision", "--base-etag", target.etag],
    { workspace: root },
  );
  assert.equal(changed.exitCode, 1);
  assert.equal(changed.stderr.split("\n")[0], "Node type must be goal, prompt or output.");
  assert.match(
    changed.stderr.split("\n").slice(1).join("\n"),
    /^Next: tent node type --help --workspace .+  # words like decision or evidence go in --tags\n$/,
  );
  const full = await cli("get", [target.nodeId, "--full"]);
  await cli("type", [target.nodeId, "goal", "--base-etag", full.etag]);
  assert.equal((await cli("get", [target.nodeId, "--view", "summary"])).type, "goal");
});

test("link-output creates a plain output and adds only the tags it is given", async (t) => {
  const { root, cli } = await fixture(t, "link-output-tags-");
  await fs.writeFile(path.join(root, "page.html"), "<p>done</p>");
  const plain = await cli("link-output", ["node-parent", "--resource", "page.html"]);
  const plainNode = await cli("get", [plain.nodeId, "--view", "summary"]);
  assert.equal(plainNode.type, "output");
  assert.deepEqual(plainNode.tags, []);
  const tagged = await cli("link-output", [
    "node-parent",
    "--resource",
    "page.html",
    "--name",
    "Tagged",
    "--tags",
    "asset,ui",
  ]);
  const taggedNode = await cli("get", [tagged.nodeId, "--view", "summary"]);
  assert.equal(taggedNode.type, "output");
  assert.deepEqual(taggedNode.tags, ["asset", "ui"]);
  assert.deepEqual(
    (await cli("list", ["--type", "output", "--tag", "asset"])).items.map(
      (item: { nodeId: string }) => item.nodeId,
    ),
    [tagged.nodeId],
  );
});
