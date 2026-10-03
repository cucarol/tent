import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { testScratchRoot } from "./scratch.js";

test("build versions come from package.json while manifest metadata survives", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "version-source-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "plugins/tent/.codex-plugin"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
  for (const name of ["manifest.json", "plugins/tent/.codex-plugin/plugin.json"]) {
    await fs.writeFile(
      path.join(root, name),
      JSON.stringify({ name: "tent", version: "0.0.0", custom: true }),
    );
  }
  const { syncVersion } = await import(
    new URL("../scripts/sync-version.mjs", import.meta.url).href
  );
  await syncVersion(root);
  for (const name of ["manifest.json", "plugins/tent/.codex-plugin/plugin.json"]) {
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, name), "utf8")), {
      name: "tent",
      version: "1.2.3",
      custom: true,
    });
  }
});
