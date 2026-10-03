import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { testScratchRoot } from "./scratch.js";
import * as path from "node:path";
import { test } from "node:test";
import { findTentSystemRoot } from "../src/core/status.js";
import { resolveWorkspacePaths } from "../src/cli/workspace-path.js";
import { tentIndexMarker } from "../src/core/scaffold.js";

test("workspace discovery skips ordinary index.md files and respects explicit boundaries", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "tent-workspace-discovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const systemRoot = path.join(root, ".tent");
  const child = path.join(root, "docs");
  await fs.mkdir(systemRoot);
  await fs.mkdir(child);
  await fs.writeFile(path.join(systemRoot, "index.md"), tentIndexMarker());
  await fs.writeFile(path.join(root, "index.md"), "# Project home\n");
  await fs.writeFile(path.join(child, "index.md"), "---\ntype: concept\n---\n# Documentation\n");
  const expected = { workspaceRoot: root, systemRoot };
  assert.deepEqual(await resolveWorkspacePaths({ workspace: root }), expected);
  assert.deepEqual(await resolveWorkspacePaths({ cwd: child }), expected);
  assert.deepEqual(await resolveWorkspacePaths({ cwd: systemRoot }), expected);
  await assert.rejects(resolveWorkspacePaths({ workspace: child }), /parent roots are not used/);
  await fs.writeFile(path.join(systemRoot, "index.md"), "# Index without optional version\n");
  assert.deepEqual(await resolveWorkspacePaths({ cwd: child }), expected);
  // 独立 Core 目录仍通过明确的结构标记发现，普通 Markdown 不是标记。
  const legacy = path.join(root, "legacy");
  await fs.mkdir(legacy);
  await fs.writeFile(path.join(legacy, "index.md"), "# Ordinary index\n");
  assert.equal(await findTentSystemRoot(legacy, legacy), undefined);
  await fs.writeFile(path.join(legacy, "index.md"), tentIndexMarker());
  assert.equal(await findTentSystemRoot(legacy), legacy);
});
