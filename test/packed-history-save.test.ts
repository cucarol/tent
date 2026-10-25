import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { NodeFs } from "../src/fs/node-fs.js";
import { readNodeForEdit } from "../src/core/read/node-query.js";
import { writeNodeDocument } from "../src/core/graph/node-document-write.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { testScratchRoot } from "./scratch.js";

for (const format of ["sha1", "sha256"] as const) {
  test(`packed HEAD preserves unchanged capture, ordinary Core save and retry (${format})`, async (t) => {
    const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "packed-history-save-"));
    t.after(() =>
      fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }),
    );
    await scaffoldInWorkspace(new NodeFs(workspace), {
      name: "Packed",
      nodes: [
        { id: "node-a", name: "A", type: "prompt", body: "OLD A\n" },
        { id: "node-b", name: "B", type: "prompt", body: "OLD B\n" },
      ],
    });
    const root = path.join(workspace, ".tent"),
      adapter = new NodeFs(root);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim();
    git("init", "--quiet", `--object-format=${format}`);
    const changes = await Promise.all(
      ["A", "B"].map(async (name) => ({
        path: `${name}/${name}.md`,
        raw: await adapter.readFile(`${name}/${name}.md`),
      })),
    );
    const initial = (await adapter.history.captureUnlocked(changes)).commit!;
    const basis = await readNodeForEdit(adapter, "node-a"),
      other = await adapter.readFile("B/B.md");
    git("pack-refs", "--all");
    const branch = git("symbolic-ref", "HEAD"),
      loose = path.join(root, ".git", branch);
    const packed = await fs.readFile(path.join(root, ".git/packed-refs"));
    await assert.rejects(fs.stat(loose), { code: "ENOENT" });
    assert.equal(await adapter.history.currentCommit(), initial);
    const unchanged = await adapter.history.captureUnlocked(changes);
    assert.equal(unchanged.created, false);
    await assert.rejects(fs.stat(loose), { code: "ENOENT" });
    const saved = await writeNodeDocument(adapter, "node-a", {
      baseEtag: basis.etag,
      body: "NEW A\n",
    });
    assert.equal(saved.changed, true);
    const head = await adapter.history.currentCommit();
    assert.notEqual(head, initial);
    assert.equal((await fs.readFile(loose, "utf8")).trim(), head);
    const retry = await writeNodeDocument(adapter, "node-a", {
      baseEtag: saved.etag,
      body: "NEW A\n",
    });
    assert.equal(retry.changed, false);
    assert.equal(await adapter.history.currentCommit(), head);
    assert.equal(git("rev-list", "--count", "HEAD"), "2");
    assert.equal(await adapter.readFile("B/B.md"), other);
    assert.deepEqual(await fs.readFile(path.join(root, ".git/packed-refs")), packed);
    assert.equal(git("status", "--porcelain"), "");
  });
}
