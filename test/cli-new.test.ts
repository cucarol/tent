import { removeTestFixture } from "./node-fs.js";
import { openTestFs } from "./node-fs.js";
import { testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { scaffoldInWorkspace } from "./scaffold.js";
import { isValidTentIndexMarker, tentIndexMarker } from "../src/core/store/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadTent } from "../src/core/store/tree.js";

const execute = promisify(execFile);
const cli = path.resolve("src/cli/tent.ts");
const run = (...args: string[]) =>
  execute(process.execPath, ["--import", "tsx", cli, ...args], {
    windowsHide: true,
    env: {
      ...process.env,
      TENT_SERVICE_DATA_DIR: path.resolve(testScratchRoot(), "new-no-service"),
    },
  });

test("new rejects retired repair flags before changing an existing Tent", async (t) => {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(scratch, "new-cli-"));
  t.after(() => removeTestFixture(workspace, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, ".tent"));
  await fs.writeFile(path.join(workspace, ".tent/existing.md"), "Keep this context");
  await assert.rejects(run("new", workspace, "--repair-existing"), /Unknown option/);
  assert.deepEqual(await fs.readdir(path.join(workspace, ".tent")), ["existing.md"]);
  assert.equal(
    await fs.readFile(path.join(workspace, ".tent/existing.md"), "utf8"),
    "Keep this context",
  );
  const { stdout } = await run("--help");
  assert.match(stdout, /with its own SQLite history/);
  assert.doesNotMatch(stdout, /--repair-existing/);
});

test("existing Git ignore entries and structural markers remain valid", async (t) => {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "scaffold-contract-"));
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  const adapter = openTestFs(root);
  const raw = "# user rules\r\n.tent/\r\n";
  await adapter.writeFile(".gitignore", raw);
  await scaffoldInWorkspace(adapter, { name: "preserve project" });
  assert.equal(await adapter.readFile(".gitignore"), raw);
  assert.equal(isValidTentIndexMarker(tentIndexMarker()), true);
  assert.equal(isValidTentIndexMarker("# bare index\n"), true);
  assert.equal(isValidTentIndexMarker("---\ntype: role\n---\n"), false);
});

test("retired agent commands remain unavailable", async () => {
  await assert.rejects(run("agent", "session-start"), /Unknown command: tent agent/);
});

test("new's local ignore file is neither a Node nor a workspace check issue", async (t) => {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "new-local-ignore-"));
  t.after(() => removeTestFixture(workspace, { recursive: true, force: true }));
  await run("new", "--workspace", workspace);
  assert.equal(await fs.readFile(path.join(workspace, ".tent/.gitignore"), "utf8"), "*\n");
  const created = JSON.parse(
    (
      await run(
        "node",
        "create",
        "Fact",
        "--type",
        "prompt",
        "--body",
        "Kept",
        "--workspace",
        workspace,
        "--json",
      )
    ).stdout,
  );
  const shown = JSON.parse(
    (await run("node", "get", created.node.nodeId, "--workspace", workspace, "--json")).stdout,
  );
  assert.equal(shown.text.trim(), "Kept");
  assert.equal((await loadTent(openTestFs(path.join(workspace, ".tent")))).byId.size, 1);
  const checked = JSON.parse(
    (await run("workspace", "check", "--workspace", workspace, "--json")).stdout,
  );
  assert.deepEqual(checked.issues, []);
  assert.deepEqual(checked.errors, []);
  assert.deepEqual(checked.notices, []);
});

test("new accepts workspace selection by flag or an equivalent positional path", async (t) => {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "new-workspace-option-"));
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  for (const name of ["flag", "both"]) {
    const workspace = path.join(root, name);
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, "README.md"), "Keep project files\n");
    const args = ["new", "--workspace", workspace];
    if (name === "both") args.push(path.relative(process.cwd(), workspace) + "/.");
    const { stdout } = await run(...args);
    assert.match(stdout, /Created Tent:/);
    assert.equal((await fs.stat(path.join(workspace, ".tent/.git"))).isDirectory(), true);
    assert.equal(
      await fs.readFile(path.join(workspace, "README.md"), "utf8"),
      "Keep project files\n",
    );
    await assert.rejects(run("new", "--workspace", workspace), /already a Tent/);
  }
  const { stdout } = await run("new", "--help");
  assert.match(stdout, /tent new --workspace <workspace-path>/);
});

test("new rejects conflicting workspace selections before creating either Tent", async (t) => {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "new-conflicting-options-"));
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  const positional = path.join(root, "positional");
  const flag = path.join(root, "flag");
  await assert.rejects(run("new", positional, "--workspace", flag), /must name the same directory/);
  assert.deepEqual(await fs.readdir(root), []);
});

test("version accepts workspace without requiring or changing a Tent", async (t) => {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "version-workspace-option-"));
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  const workspace = path.join(root, "not-created");
  const expected = (await run("--version")).stdout;
  for (const command of ["--version", "version", "-v"]) {
    const { stdout } = await run(command, "--workspace", workspace);
    assert.equal(stdout, expected);
  }
  const { stdout } = await run("version", "--json", "--workspace", workspace);
  assert.equal(JSON.parse(stdout).runtimePath, cli);
  assert.deepEqual(await fs.readdir(root), []);
});
