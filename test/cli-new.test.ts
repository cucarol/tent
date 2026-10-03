import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  ensureWorkspaceGitignore,
  isValidTentIndexMarker,
  tentIndexMarker,
} from "../src/core/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";

const execute = promisify(execFile);
const cli = path.resolve("src/cli/tent.ts");
const run = (...args: string[]) =>
  execute(process.execPath, ["--import", "tsx", cli, ...args], {
    windowsHide: true,
    env: { ...process.env, TENT_SERVICE_DATA_DIR: path.resolve(".scratch/new-no-service") },
  });

test("new rejects retired repair flags before changing an existing Tent", async (t) => {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(scratch, "new-cli-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, ".tent"));
  await fs.writeFile(path.join(workspace, ".tent/existing.md"), "Keep this context");
  await assert.rejects(run("new", workspace, "--repair-existing"), /Unknown option/);
  assert.deepEqual(await fs.readdir(path.join(workspace, ".tent")), ["existing.md"]);
  assert.equal(
    await fs.readFile(path.join(workspace, ".tent/existing.md"), "utf8"),
    "Keep this context",
  );
  const { stdout } = await run("--help");
  assert.match(stdout, /independent local Git/);
  assert.doesNotMatch(stdout, /--repair-existing/);
});

test("existing Git ignore entries and structural markers remain valid", async (t) => {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "scaffold-contract-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const adapter = new NodeFs(root);
  for (const entry of [".tent/", "/.tent/", ".tent", "/.tent"]) {
    const raw = `# user rules\r\n${entry}\r\n`;
    await adapter.writeFile(".gitignore", raw);
    await ensureWorkspaceGitignore(adapter);
    assert.equal(await adapter.readFile(".gitignore"), raw);
  }
  assert.equal(isValidTentIndexMarker(tentIndexMarker()), true);
  assert.equal(isValidTentIndexMarker("# bare index\n"), true);
  assert.equal(isValidTentIndexMarker("---\ntype: role\n---\n"), false);
});

test("retired agent commands remain unavailable", async () => {
  await assert.rejects(run("agent", "session-start"), /Unknown command: agent/);
});
