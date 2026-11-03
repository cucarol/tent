import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runLoadCommand } from "../src/cli/load-command.js";
import { initializeTentWorkspace } from "../src/fs/workspace-init.js";
import { removeTestFixture } from "./node-fs.js";

const execute = promisify(execFile);
const scratch = fileURLToPath(new URL("../.scratch/judge-loop-types/load/", import.meta.url));

async function fixture(t: TestContext) {
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "case-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }),
  );
  await execute("git", ["-C", root, "init", "--quiet", "-b", "main"], { windowsHide: true });
  await initializeTentWorkspace(root);
  const systemRoot = path.join(root, ".tent");
  async function node(place: string, type: string, metadata = "") {
    const name = path.posix.basename(place);
    const file = path.join(systemRoot, place, `${name}.md`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      `---\nid: node-${name.toLowerCase()}\ntype: ${type}\n${metadata}---\nBody of ${name}.\n`,
    );
    return file;
  }
  return { root, systemRoot, node };
}

test("tent load lists the covering Nodes, then direct prompts of each and of every goal above, nearest first", async (t) => {
  const f = await fixture(t);
  await f.node("Product", "goal", "description: What the product is for.\n");
  const ways = await f.node("Product/Ways", "prompt", "description: How we work.\n");
  await f.node("Product/Auth", "goal", "resource: ../../../src/auth/\n");
  const codes = await f.node("Product/Auth/Codes", "prompt", "description: Email codes.\n");
  await f.node("Product/Auth/Old", "prompt", "status: deprecated\n");
  const login = await f.node(
    "Product/Auth/Login",
    "output",
    "description: The sign-in page.\nresource: ../../../../src/auth/login.ts\n",
  );
  const style = await f.node("Product/Auth/Login/Style", "prompt");
  const result = await runLoadCommand([
    "--workspace",
    f.root,
    path.join(f.root, "src", "auth", "login.ts"),
  ]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(
    result.stdout,
    "These Tent Nodes cover src/auth/login.ts:\n" +
      `- Login (output): ${login} — The sign-in page.\n\n` +
      "Prompts above them, nearest first:\n" +
      `- Style (prompt): ${style}\n` +
      `- Codes (prompt): ${codes} — Email codes.\n` +
      `- Ways (prompt): ${ways} — How we work.\n`,
  );
});

test("tent load says when no Node covers the files and refuses paths outside the Workspace", async (t) => {
  const f = await fixture(t);
  await f.node("Docs", "goal", "resource: ../../docs/\n");
  const none = await runLoadCommand(["--workspace", f.root, path.join(f.root, "src", "a.ts")]);
  assert.equal(none.exitCode, 0, none.stderr);
  assert.equal(none.stdout, "No Tent Node covers src/a.ts.\n");
  const outside = path.join(path.dirname(f.root), "elsewhere.ts");
  const refused = await runLoadCommand(["--workspace", f.root, outside]);
  assert.equal(refused.exitCode, 1);
  assert.equal(refused.stderr, `${outside} is outside the Workspace at ${f.root}.\n`);
});
