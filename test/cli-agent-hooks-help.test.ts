import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runHookCommand } from "../src/cli/hook.js";

const root = fileURLToPath(new URL("../", import.meta.url));

test("both native packages register only Stop", async () => {
  for (const host of ["codex", "claude-code"]) {
    const hooks = JSON.parse(
      await fs.readFile(path.join(root, "plugins", host, "tent/hooks/hooks.json"), "utf8"),
    ).hooks;
    assert.deepEqual(Object.keys(hooks), ["Stop"]);
    assert.equal(hooks.Stop[0].hooks[0].type, "command");
    assert.match(hooks.Stop[0].hooks[0].command, /-- stop$/);
  }
  const help = await runHookCommand("help", [], { packageRoot: root });
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /tent hook stop --host codex\|claude-code/);
});
