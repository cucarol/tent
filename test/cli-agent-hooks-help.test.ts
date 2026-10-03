import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const scratch = path.join(root, ".scratch");
const run = promisify(execFile);

test("retired hook installer always rejects and leaves existing host configuration unchanged", async () => {
  await fs.mkdir(scratch, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(scratch, "agent-hooks-help-"));
  const home = path.join(fixture, "home");
  const config = path.join(home, ".codex", "hooks.json");
  const original =
    JSON.stringify(
      {
        hooks: {
          SessionStart: [
            {
              hooks: [
                { type: "command", command: "custom-hook" },
                {
                  type: "command",
                  command: "tent session session-start --host codex",
                  timeout: 60,
                  statusMessage: "tent-managed-hook",
                },
              ],
            },
          ],
          SessionEnd: [
            {
              hooks: [
                {
                  type: "command",
                  command: "tent session session-end --host codex",
                  timeout: 3,
                  statusMessage: "tent-managed-hook",
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ) + "\n";
  try {
    await fs.mkdir(path.dirname(config), { recursive: true });
    await fs.writeFile(config, original);
    const cli = async (args: string[]) =>
      run(
        process.execPath,
        ["--import", "tsx", "src/cli/tent.ts", "agent-hooks", ...args, "--home", home],
        {
          cwd: root,
          windowsHide: true,
          timeout: 30_000,
        },
      );
    for (const args of [
      ["remove", "--help"],
      ["install", "-h"],
    ]) {
      await assert.rejects(cli(args), /Unknown command: agent-hooks/);
      assert.equal(await fs.readFile(config, "utf8"), original);
    }
    for (const args of [
      ["remove", "--not-a-flag"],
      ["install", "--agent"],
    ]) {
      await assert.rejects(cli(args));
      assert.equal(await fs.readFile(config, "utf8"), original);
    }
    assert.deepEqual(await fs.readdir(path.dirname(config)), ["hooks.json"]);
  } finally {
    const relative = path.relative(scratch, fixture);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(fixture, { recursive: true, force: true });
  }
});
