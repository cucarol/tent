import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import {
  createRoleContext,
  editRoleContext,
  readRoleContext,
  readRolePage,
  listRoleContexts,
} from "../src/core/role-context.js";
import { parseFrontmatter } from "../src/core/frontmatter.js";
import { contentEtag } from "../src/core/etag.js";
import { runRoleCommand } from "../src/cli/role-commands.js";
import { git } from "./helpers.js";

async function fixture(t: TestContext) {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "role-context-"));
  t.after(async () => {
    assert.equal(path.dirname(root), scratch);
    await fs.rm(root, { recursive: true, force: true });
  });
  await scaffoldInWorkspace(new NodeFs(root), { name: "roles" });
  const adapter = new NodeFs(path.join(root, ".tent"));
  await git(path.join(root, ".tent"), "init");
  return { root, adapter };
}

test("Role reads use only the selected document, never registry, Node imports or mutation recovery", async (t) => {
  const { adapter } = await fixture(t);
  await createRoleContext(adapter, {
    roleId: "role-review",
    title: "Review",
    body: "Independent instructions.",
  });
  await adapter.writeFile("roles.json", "invalid legacy registry");
  await adapter.writeFile("node-move.pending.json", "not a repair request");
  const binary = adapter.readBinary.bind(adapter),
    read = adapter.readFile.bind(adapter);
  adapter.readBinary = async (p) => {
    assert.equal(p, "roles/role-review.md");
    return binary(p);
  };
  adapter.readFile = async () => {
    throw new Error("No other body should be loaded");
  };
  const writes: string[] = [];
  const write = adapter.writeFile.bind(adapter);
  adapter.writeFile = async (p, raw) => {
    writes.push(p);
    await write(p, raw);
  };
  const document = await readRoleContext(adapter, "role-review", { capture: true });
  assert.equal(document.body, "Independent instructions.");
  assert.equal(await adapter.history.read(document.version!), document.raw);
  const listed = await listRoleContexts(adapter);
  assert.deepEqual(
    listed.items.map((r) => r.roleId),
    ["role-review"],
  );
  assert.deepEqual(writes, []);
  assert.equal(await read("roles.json"), "invalid legacy registry");
  await assert.rejects(() => readRoleContext(adapter, "role-missing"), /not found/);
});

test("Role no-op retains exact bytes and explicit edits preserve unknown YAML and local status", async (t) => {
  const { adapter } = await fixture(t);
  const raw =
    "\uFEFF---\r\ntype: role\r\nid: role-review\r\nstatus: deprecated\r\ncustom: {x: [one, two]} # keep\r\n---\r\nold text\r\n";
  await adapter.writeFile("roles/role-review.md", raw);
  const calls: string[] = [],
    write = adapter.writeFile.bind(adapter);
  adapter.writeFile = async (p, value) => {
    calls.push(p);
    await write(p, value);
  };
  const noop = await editRoleContext(adapter, "role-review", {
    body: "old text\r\n",
    baseEtag: contentEtag(raw),
  });
  assert.equal(noop.changed, false);
  assert.deepEqual(calls, []);
  assert.equal(await adapter.history.read(noop.version!), raw);
  const saved = await editRoleContext(adapter, "role-review", {
    body: "new text\r\n",
    baseEtag: noop.etag,
  });
  const after = await readRoleContext(adapter, "role-review");
  assert.equal(after.etag, saved.etag);
  assert.equal(after.raw, raw.replace("old text", "new text"));
  assert.equal(parseFrontmatter(after.raw).data.status, "deprecated");
  await assert.rejects(
    () => editRoleContext(adapter, "role-review", { baseEtag: noop.etag, body: "stale" }),
    /changed/,
  );
  await assert.rejects(
    () =>
      editRoleContext(adapter, "role-review", {
        baseEtag: saved.etag,
        frontmatter: { id: "role-another" },
      }),
    /mismatch/,
  );
  assert.deepEqual(calls, ["roles/role-review.md"]);
});

test("long Role reads continue across fresh CLI processes and reject changes between pages", async (t) => {
  const { root, adapter } = await fixture(t);
  const body = "中文😀\r\n".repeat(7000);
  await createRoleContext(adapter, { roleId: "role-long", title: "Long", body });
  const first = await readRolePage(adapter, "role-long");
  assert.equal(first.text, body);
  const unqualified = await runRoleCommand("show", ["role-long", "--start", "2", "--end", "10"], {
    workspace: root,
  });
  assert.equal(unqualified.exitCode, 1);
  assert.match(unqualified.stderr, /expected-etag/);
  const next = {
    view: "body" as const,
    range: { unit: "utf16" as const, start: 1000, end: body.length },
    expectedEtag: first.etag,
  };
  const script =
    "import {runRoleCommand} from './src/cli/role-commands.ts'; const r=await runRoleCommand('show',JSON.parse(process.argv[1]),{workspace:process.argv[2]}); process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exitCode=r.exitCode;";
  const args = [
    "role-long",
    "--start",
    String(next.range.start),
    "--end",
    String(next.range.end),
    "--expected-etag",
    next.expectedEtag,
    "--json",
  ];
  const result = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script, JSON.stringify(args), root],
    { cwd: process.cwd(), windowsHide: true },
  );
  const second = JSON.parse(result.stdout);
  assert.equal(second.range.start, next.range.start);
  assert.equal(second.text, body.slice(next.range.start, second.range.end));
  await adapter.writeFile(
    "roles/role-long.md",
    (await adapter.readFile("roles/role-long.md")) + "external edit",
  );
  await assert.rejects(() => readRolePage(adapter, "role-long", next), /changed/);
});

test("two CLI processes cannot both save a Role against the same observed bytes", async (t) => {
  const { root, adapter } = await fixture(t);
  const created = await createRoleContext(adapter, {
    roleId: "role-shared",
    title: "Shared",
    body: "initial",
  });
  const script =
    "import {runRoleCommand} from './src/cli/role-commands.ts'; const r=await runRoleCommand('write',JSON.parse(process.argv[1]),{workspace:process.argv[2]}); process.stdout.write(JSON.stringify(r));";
  const run = (body: string) =>
    promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        script,
        JSON.stringify(["role-shared", "--body", body, "--base-etag", created.etag]),
        root,
      ],
      { cwd: process.cwd(), windowsHide: true },
    );
  const results = (await Promise.all([run("first"), run("second")])).map((r) =>
    JSON.parse(r.stdout),
  );
  assert.equal(results.filter((r) => r.exitCode === 0).length, 1);
  assert.match(
    results.find((r) => r.exitCode !== 0).stderr,
    /changed|already running another write operation/i,
  );
  const latest = await readRoleContext(adapter, "role-shared");
  assert.ok(["first", "second"].includes(latest.body));
  assert.match(await adapter.history.read(created.version!), /initial/);
});

test("Role CLI works without Service and legacy or missing Roles never become empty open context", async (t) => {
  const { root, adapter } = await fixture(t);
  const registry = "legacy registry is not consulted";
  await adapter.writeFile("roles.json", registry);
  const created = await runRoleCommand("create", ["--title", "审查", "--body", "-", "--json"], {
    workspace: root,
    stdin: "--instructions\r\n",
  });
  assert.equal(created.exitCode, 0, created.stderr);
  const saved = JSON.parse(created.stdout);
  const shown = await runRoleCommand("show", [saved.roleId], { workspace: root, json: true });
  assert.equal(JSON.parse(shown.stdout).text, "--instructions\r\n");
  assert.equal(await adapter.readFile("roles.json"), registry);
  const legacy = "---\ntype: role\nroleId: role-old\n---\noriginal\n";
  await adapter.writeFile("roles/role-old.md", legacy);
  await assert.rejects(() => readRoleContext(adapter, "role-old"), /identity.*path mismatch/);
  assert.equal(await adapter.readFile("roles/role-old.md"), legacy);
  assert.ok(
    (await listRoleContexts(adapter)).items.find((r) => r.roleId === "role-old")!.diagnostic,
  );
  assert.equal(
    (await adapter.listDir("roles")).some(
      (r) => r.name.endsWith(".cards.json") || r.name.endsWith(".original"),
    ),
    false,
  );
});

test("Role writes canonicalize known Node ids in Markdown links", async (t) => {
  const { adapter } = await fixture(t);
  await adapter.writeFile("Fact/Fact.md", "---\nid: node-fact\ntype: prompt\n---\nFact");
  const created = await createRoleContext(adapter, {
    roleId: "role-links",
    title: "Links",
    body: "[fact](node-fact)",
  });
  assert.equal((await readRoleContext(adapter, created.roleId)).body, "[fact](../Fact/Fact.md)");
});
