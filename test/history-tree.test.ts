import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import type { FsAdapter } from "../src/core/store/adapter.js";
import { GitDocumentHistory } from "../src/core/store/git-history.js";
import { readHistoryTree } from "../src/core/read/history-query.js";
import { readDocumentVersion } from "../src/core/read/document-diff.js";

const raw = (id: string, type = "prompt", body = id) =>
  `---\nid: ${id}\ntype: ${type}\n---\n${body}`;

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  await fs.mkdir(".scratch", { recursive: true });
  const root = await fs.mkdtemp(path.resolve(".scratch/history-tree-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim();
  git("init", "--quiet");
  const history = new GitDocumentHistory(root);
  // No live filesystem method is available to this projection.
  const adapter = new Proxy(
    { history },
    {
      get(target, key) {
        if (key === "history") return target.history;
        throw new Error(`History must not access live adapter ${String(key)}`);
      },
    },
  ) as FsAdapter;
  const first = (
    await history.captureUnlocked([
      { path: "Parent/Parent.md", raw: raw("node-parent", "goal") },
      { path: "Parent/Old/Old.md", raw: raw("node-child", "prompt", "old text") },
      { path: "Parent/Gone/Gone.md", raw: raw("node-gone", "output") },
      { path: "Group/Deep/Deep.md", raw: raw("node-deep") },
      { path: "roles/role-bot.md", raw: "---\nid: role-bot\n---\n" },
    ])
  ).commit!;
  const second = (
    await history.captureUnlocked([
      { path: "Parent/Old/Old.md", raw: null },
      { path: "New/New.md", raw: raw("node-child", "output", "new text") },
      { path: "Parent/Gone/Gone.md", raw: null },
      { path: "Later/Later.md", raw: raw("node-later") },
    ])
  ).commit!;
  return { root, git, history, adapter, first, second };
}

async function bytes(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(dir: string) {
    for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else
        result[file] = createHash("sha256")
          .update(await fs.readFile(path.join(root, file)))
          .digest("hex");
    }
  }
  await visit("");
  return result;
}

test("historical tree reads exact identity facts through rename, move, type change and deletion without writes", async (t) => {
  const { root, adapter, first, second } = await fixture(t);
  // Uncaptured live bytes and current order cannot become historical facts.
  await fs.mkdir(path.join(root, "New"), { recursive: true });
  await fs.writeFile(path.join(root, "New/New.md"), raw("node-child", "goal", "external edit"));
  await fs.writeFile(path.join(root, "order.json"), '{"__root__":["node-later"]}');
  const before = await bytes(root);
  const old = await readHistoryTree(adapter, first);
  assert.deepEqual(old.nodes.map((node) => [node.id, node.name, node.type, node.parentId]).sort(), [
    ["node-child", "Old", "prompt", "node-parent"],
    ["node-deep", "Deep", "prompt", null],
    ["node-gone", "Gone", "output", "node-parent"],
    ["node-parent", "Parent", "goal", null],
  ]);
  const child = old.nodes.find((node) => node.id === "node-child")!;
  assert.deepEqual(child.version, { commit: first, path: "Parent/Old/Old.md" });
  assert.equal(
    (await readDocumentVersion(adapter, child.version)).raw,
    raw("node-child", "prompt", "old text"),
  );
  const gone = old.nodes.find((node) => node.id === "node-gone")!;
  assert.match((await readDocumentVersion(adapter, gone.version)).raw, /node-gone/);
  const latest = await readHistoryTree(adapter, second);
  assert.equal(
    latest.nodes.some((node) => node.id === "node-gone"),
    false,
  );
  assert.deepEqual(
    latest.nodes.find((node) => node.id === "node-child"),
    {
      id: "node-child",
      name: "New",
      type: "output",
      path: "New",
      parentId: null,
      version: { commit: second, path: "New/New.md" },
    },
  );
  assert.deepEqual(await bytes(root), before);
});

test("historical tree rejects invalid, unreachable and duplicate identities", async (t) => {
  const { adapter, history, git, second } = await fixture(t);
  await assert.rejects(readHistoryTree(adapter, "HEAD"));
  const orphan = git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit-tree",
    `${second}^{tree}`,
    "-m",
    "unreachable",
  );
  await assert.rejects(readHistoryTree(adapter, orphan));
  const duplicate = (
    await history.captureUnlocked([{ path: "Duplicate/Duplicate.md", raw: raw("node-parent") }])
  ).commit!;
  await assert.rejects(readHistoryTree(adapter, duplicate), /Duplicate historical identity/);
});
