import assert from "node:assert/strict";
import { test } from "node:test";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";

test("workspace export help has no discovery or file effects", async () => {
  for (const args of [["--help"], ["-h"], ["help"]]) {
    const result = await runWorkspaceCommand("export", args, { workspace: "missing-fixture" });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /--output/);
  }
});
