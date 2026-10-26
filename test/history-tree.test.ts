import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import type { FsAdapter } from "../src/core/store/adapter.js";
import {
  SqliteDocumentHistory,
  sqliteContentFingerprint,
} from "../src/core/store/sqlite-history.js";
import { DatabaseSync } from "../src/fs/sqlite-runtime.js";
import { importGitHistory } from "../src/fs/import-git-history.js";
import { testScratchRoot } from "./scratch.js";
import { readHistoryTree } from "../src/core/read/history-query.js";
import { readDocumentVersion } from "../src/core/read/document-diff.js";

const raw = (id: string, type = "prompt", body = id) =>
  `---\nid: ${id}\ntype: ${type}\n---\n${body}`;

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "history-tree-"));
  const history = new SqliteDocumentHistory(root);
  await history.initialize();
  t.after(async () => {
    await history.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });
  // No live filesystem method is available to this projection.
  const adapter = new Proxy(
    { history },
    {
      get(target, key) {
        if (key === "history") return target.history;
        throw new Error(`History must not access live adapter ${String(key)}`);
      },
    },
  ) as unknown as FsAdapter;
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
  return { root, history, adapter, first, second };
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

test("historical tree accepts only published events, not invalid IDs or unpublished content", async (t) => {
  const { root, adapter, history, second } = await fixture(t);
  await assert.rejects(readHistoryTree(adapter, "HEAD"));
  // SQLite keeps one append-only published event chain. A stored blob is not an event.
  const unpublished = raw("node-unpublished"),
    digest = sqliteContentFingerprint(unpublished);
  const db = new DatabaseSync(path.join(root, ".git/history.sqlite"));
  try {
    db.prepare("INSERT INTO blobs(digest,raw) VALUES(?,?)").run(digest, unpublished);
  } finally {
    db.close();
  }
  await assert.rejects(readHistoryTree(adapter, digest), /Unknown SQLite event/);
  let unpublishedEvent: string | undefined;
  await assert.rejects(
    history.withPublicationObserver(
      {
        before: async (id) => {
          unpublishedEvent = id;
        },
        after: async () => {},
      },
      () => history.captureUnlocked([{ path: "Duplicate/Duplicate.md", raw: raw("node-parent") }]),
    ),
    /Duplicate historical identity/,
  );
  assert.ok(unpublishedEvent);
  await assert.rejects(readHistoryTree(adapter, unpublishedEvent), /Unknown SQLite event/);
  assert.equal(await history.currentCommit(), second);
});

test("historical tree rejects duplicate identities retained by a legacy import", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "history-tree-import-")),
    source = path.join(root, "source"),
    target = path.join(root, "target");
  await fs.mkdir(source);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", source, ...args], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
  git("init", "--quiet", "--initial-branch=main");
  for (const name of ["One", "Two"]) {
    await fs.mkdir(path.join(source, name));
    await fs.writeFile(path.join(source, name, `${name}.md`), raw("node-duplicate"));
  }
  git("add", "--all");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "legacy duplicate",
  );
  const imported = await importGitHistory(source, target);
  const history = new SqliteDocumentHistory(target);
  t.after(async () => {
    await history.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });
  await assert.rejects(
    readHistoryTree(
      { history } as unknown as FsAdapter,
      imported.mapping[git("rev-parse", "HEAD")]!,
    ),
    /Duplicate historical identity/,
  );
});
