import { openTestFs, removeTestFixture } from "./node-fs.js";
import { initializeFixtureHistory, testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scaffoldInWorkspace } from "./scaffold.js";

test("separate CLI processes retain native edits through brief and read the original history version", async (t) => {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "history-process-"));
  t.after(() => removeTestFixture(workspace, { recursive: true, force: true }));
  await scaffoldInWorkspace(openTestFs(workspace), {
    name: "History",
    nodes: [{ id: "node-alpha", name: "A", type: "prompt", body: "Original body" }],
  });
  const adapter = openTestFs(path.join(workspace, ".tent"));
  await initializeFixtureHistory(path.join(workspace, ".tent"));
  const raw = await fs.readFile(path.join(workspace, ".tent/A/A.md"), "utf8");
  const captured = await adapter.history.captureUnlocked([{ path: "A/A.md", raw }], {
    operation: "test.fixture",
  });
  const run = (args: string[]) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          fileURLToPath(new URL("../src/cli/tent.ts", import.meta.url)),
          ...args,
          "--workspace",
          workspace,
        ],
        { windowsHide: true },
      );
      let stdout = "",
        stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  await fs.writeFile(path.join(workspace, ".tent/A/A.md"), raw.replace("Original", "Native edit"));
  const checked = await run(["workspace", "check", "--json"]);
  assert.equal(checked.code, 0, checked.stderr);
  const version = captured.versions[0]!;
  assert.notEqual(await adapter.history.currentCommit(), version.commit);
  const historical = await run([
    "node",
    "history",
    "node-alpha",
    "--version",
    JSON.stringify(version),
  ]);
  assert.equal(historical.code, 0, historical.stderr);
  assert.equal(historical.stdout, raw);
});
