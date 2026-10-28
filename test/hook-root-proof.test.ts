import { removeTestFixture } from "./node-fs.js";
import { testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import { initializeTentWorkspace } from "../src/fs/workspace-init.js";
import { runHookCommand } from "../src/cli/hook.js";
import { runToolHook } from "../src/cli/tool-hook.js";
import { findTentSystemRoot } from "../src/core/workspace/status.js";
import { findPreparedHookWorkspace } from "../src/fs/hook-material-index.js";
import { git } from "./helpers.js";

async function fixture(t: TestContext, id = "node-proof") {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "root-proof-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await git(root, "init", "--quiet");
  await initializeTentWorkspace(root);
  const system = path.join(root, ".tent");
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src/code.ts"), "code\n");
  await fs.mkdir(path.join(system, "Module"));
  await fs.writeFile(
    path.join(system, "Module/Module.md"),
    `---\nid: ${id}\ntype: prompt\nsources:\n  - resource: ../../src/\n    track: structure\n---\nRule\n`,
  );
  const marker = path.join(system, "index.md");
  const cache = path.join(system, ".git/tent-material-cache/stop-material-index.json");
  const prepare = async (cwd = root) => {
    const result = await runHookCommand("start", ["--host", "codex"], {
      packageRoot: process.cwd(),
      stdin: JSON.stringify({ hook_event_name: "SessionStart", cwd }),
    });
    assert.ok(JSON.parse(result.stdout).hookSpecificOutput?.additionalContext, result.stdout);
  };
  const tool = (cwd = root, turn = "turn", file = path.join(root, "src/code.ts")) =>
    runToolHook("codex", {
      hook_event_name: "PostToolUse",
      cwd,
      session_id: "session",
      turn_id: turn,
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** End Patch" },
      tool_response: `Success. Updated the following files:\nM ${file}\n`,
    });
  return { root, system, marker, cache, prepare, tool };
}

test("Core-prepared noncanonical YAML marker bytes work without a tool YAML parser", async (t) => {
  const f = await fixture(t);
  const markers = [
    "---\n{okf_version: '0.2', note: [one, two]}\n---\nbody\n",
    "---\nokf_version: &version '0.2'\ncopy: *version\n---\nbody\n",
    "---\n# .tent needs no explicit version\nvalue: |\n  text\n---\nbody\n",
  ];
  for (const [i, marker] of markers.entries()) {
    await fs.writeFile(f.marker, marker);
    assert.equal(await findTentSystemRoot(f.root), f.system);
    await f.prepare();
    assert.equal((await findPreparedHookWorkspace(f.root))?.systemRoot, f.system);
    assert.match(await f.tool(f.root, String(i)), /node-proof/);
  }
});

test("changed marker bytes require SessionStart again; tool lookup never refreshes the cache", async (t) => {
  const f = await fixture(t);
  await f.prepare();
  const before = await fs.readFile(f.cache);
  await fs.appendFile(f.marker, "changed body\n");
  assert.equal(await findTentSystemRoot(f.root), f.system);
  assert.equal(await f.tool(), "{}\n");
  assert.deepEqual(await fs.readFile(f.cache), before);
  await f.prepare();
  assert.match(await f.tool(f.root, "new"), /node-proof/);
});

test("ordinary project and subdirectory index.md rejection proofs preserve the Core route", async (t) => {
  const f = await fixture(t);
  const sub = path.join(f.root, "src/sub");
  await fs.mkdir(sub);
  await fs.writeFile(path.join(f.root, "index.md"), "Ordinary project index\n");
  await fs.writeFile(path.join(f.root, "src/index.md"), "---\nlabel: ordinary\n---\n");
  await fs.writeFile(path.join(sub, "index.md"), "Plain subdirectory index\n");
  assert.equal(await findTentSystemRoot(sub), f.system);
  await f.prepare(sub);
  assert.equal((await findPreparedHookWorkspace(f.root))?.systemRoot, f.system);
  assert.equal((await findPreparedHookWorkspace(sub))?.systemRoot, f.system);
  assert.match(await f.tool(sub), /node-proof/);
  const other = path.join(f.root, "other");
  await fs.mkdir(other);
  await fs.writeFile(path.join(other, "index.md"), "Another session index\n");
  await f.prepare(other);
  assert.equal((await findPreparedHookWorkspace(sub))?.systemRoot, f.system);
  const before = await fs.readFile(f.cache);
  await fs.appendFile(path.join(sub, "index.md"), "changed\n");
  assert.equal(await findTentSystemRoot(sub), f.system);
  assert.equal(await f.tool(sub, "changed"), "{}\n");
  assert.deepEqual(await fs.readFile(f.cache), before);
  await f.prepare(sub);
  assert.match(await f.tool(sub, "prepared-again"), /node-proof/);
});

test("unproved candidate markers cannot inherit a parent root or reverse candidate priority", async (t) => {
  const f = await fixture(t);
  await f.prepare();
  const inner = path.join(f.root, "inner");
  await fs.mkdir(path.join(inner, ".tent"), { recursive: true });
  await fs.writeFile(path.join(inner, ".tent/index.md"), "---\nokf_version: '0.2'\n---\n");
  assert.equal(await findTentSystemRoot(inner), path.join(inner, ".tent"));
  assert.equal(await findPreparedHookWorkspace(inner), undefined);
  await fs.writeFile(path.join(inner, ".tent/index.md"), "---\ntype: goal\n---\n");
  assert.equal(await findTentSystemRoot(inner), f.system);
  assert.equal(await findPreparedHookWorkspace(inner), undefined);
});

test("missing, old, malformed and foreign-root cache proofs stay silent", async (t) => {
  const f = await fixture(t);
  await f.prepare();
  const raw = await fs.readFile(f.cache, "utf8");
  const cached = JSON.parse(raw);
  for (const value of [
    "broken",
    JSON.stringify({ ...cached, schema: 6 }),
    JSON.stringify({ ...cached, rootMarkerDigest: "0".repeat(64) }),
    JSON.stringify({ ...cached, workspaceRoot: path.dirname(f.root) }),
    JSON.stringify({ ...cached, rejectedRootMarkers: [{ root: f.root, digest: "bad" }] }),
  ]) {
    await fs.writeFile(f.cache, value);
    assert.equal(await f.tool(), "{}\n");
    assert.equal(await fs.readFile(f.cache, "utf8"), value);
  }
  await fs.rm(f.cache);
  assert.equal(await f.tool(), "{}\n");
  await assert.rejects(fs.access(f.cache));
  await fs.writeFile(f.cache, raw);
  assert.match(await f.tool(), /node-proof/);
});

test("malformed markers remain rejected by the normal Core discovery", async (t) => {
  const f = await fixture(t);
  await f.prepare();
  for (const marker of [
    "---\nvalue: [\n---\n",
    "---\ntype: prompt\n---\n",
    "---\nokf_version: '0.3'\n---\n",
  ]) {
    await fs.writeFile(f.marker, marker);
    assert.equal(await findTentSystemRoot(f.root), undefined);
    assert.equal(await findPreparedHookWorkspace(f.root), undefined);
    assert.equal(await f.tool(), "{}\n");
  }
});

test("linked roots use their owning main proof; a foreign copied cache cannot supply coverage", async (t) => {
  const f = await fixture(t);
  const other = await fixture(t, "node-foreign");
  await f.prepare();
  await other.prepare();
  const linked = path.join(f.root, "foreign-linked");
  const pointer = path.join(other.root, ".git/worktrees/topic");
  await fs.mkdir(linked);
  await fs.mkdir(pointer, { recursive: true });
  await fs.writeFile(path.join(pointer, "commondir"), "../..\n");
  await fs.writeFile(path.join(linked, ".git"), `gitdir: ${pointer}\n`);
  await fs.mkdir(path.join(linked, "src"));
  const file = path.join(linked, "src/code.ts");
  await fs.writeFile(file, "branch\n");
  assert.equal(await findTentSystemRoot(linked), other.system);
  assert.equal((await findPreparedHookWorkspace(linked))?.systemRoot, other.system);
  assert.match(await other.tool(linked, "foreign", file), /node-foreign/);
  assert.doesNotMatch(
    await other.tool(linked, "foreign2", path.join(f.root, "src/code.ts")),
    /node-proof|node-foreign/,
  );
  await fs.copyFile(f.cache, other.cache);
  assert.equal(await findPreparedHookWorkspace(linked), undefined);
  assert.equal(await other.tool(linked, "bad-cache", file), "{}\n");
});

test("an explicit non-.tent marker retains Core priority over a prepared child workspace", async (t) => {
  const f = await fixture(t);
  await f.prepare();
  await fs.writeFile(
    path.join(f.root, "index.md"),
    "---\n{okf_version: '0.2', custom: [one, two]}\n---\n",
  );
  assert.equal(await findTentSystemRoot(f.root), f.root);
  assert.equal(await findPreparedHookWorkspace(f.root), undefined);
  assert.equal(await f.tool(), "{}\n");
});

test("main schema 7 coverage cannot stand in for schema 8 marker preparation", async (t) => {
  const f = await fixture(t);
  await f.prepare();
  const old = JSON.parse(await fs.readFile(f.cache, "utf8"));
  old.schema = 7;
  delete old.rootMarkerDigest;
  delete old.rejectedRootMarkers;
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  old.sourceDigest = hash([old.writtenAtNs, old.directories, old.headers]);
  old.indexDigest = hash(old.index);
  const raw = JSON.stringify(old);
  await fs.writeFile(f.cache, raw);
  assert.equal(await f.tool(), "{}\n");
  assert.equal(await fs.readFile(f.cache, "utf8"), raw);
  await f.prepare();
  assert.equal(JSON.parse(await fs.readFile(f.cache, "utf8")).schema, 10);
  assert.match(await f.tool(f.root, "prepared-v8"), /node-proof/);
});

test("fresh prepared tool coverage excludes draft owners and retains their stable children", async (t) => {
  const f = await fixture(t);
  const parent = path.join(f.system, "Module/Module.md");
  await fs.writeFile(
    parent,
    (await fs.readFile(parent, "utf8")).replace("type: prompt", "type: prompt\nstatus: draft"),
  );
  const child = path.join(f.system, "Module/Child");
  await fs.mkdir(child);
  await fs.writeFile(
    path.join(child, "Child.md"),
    "---\nid: node-child\ntype: prompt\nsources:\n  - resource: ../../../src/\n    track: structure\n---\nStable child\n",
  );
  await f.prepare();
  const output = await f.tool();
  assert.match(output, /node-child/);
  assert.doesNotMatch(output, /node-proof/);
  assert.match(output, /Module \/ Child/);
});
