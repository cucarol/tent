import { test } from "node:test";
import assert from "node:assert/strict";
import { testScratchRoot } from "./scratch.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadTent } from "../src/core/tree.js";
import {
  NODE_FRONTMATTER_KEY_ORDER,
  parseFrontmatter,
  serializeFrontmatter,
} from "../src/core/frontmatter.js";
import { scaffoldInWorkspace, scaffoldTent } from "../src/core/scaffold.js";
import { findNodesByTag, collectNodeTags } from "../src/core/tags.js";
import { readNodeForEdit } from "../src/core/node-query.js";
import { writeNodeDocument } from "../src/core/node-document-write.js";
import { makeTent } from "./helpers.js";

async function saveTags(fs: NodeFs, nodeId: string, tags: string[]) {
  const edit = await readNodeForEdit(fs, nodeId);
  return writeNodeDocument(fs, nodeId, { baseEtag: edit.etag, frontmatter: { tags } });
}

test("scaffoldTent:core 生成自包含帐骨架(index,不进 SPEC/CLAUDE/AGENTS)", async () => {
  const dir = await fs.mkdtemp(path.join(testScratchRoot(), "tent-scaffold-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, {
    name: "demo",
    nodes: [
      { name: "aim", type: "goal", body: "# demo · aim" },
      { name: "out", type: "output-asset" },
    ],
  });

  const tent = await loadTent(fsa);
  assert.deepEqual(tent.roots.map((box) => box.path).sort(), ["aim", "out"]);
  assert.match(await fsa.readFile("aim/aim.md"), /# demo · aim/);
  assert.match(await fsa.readFile("out/out.md"), /type: output-asset/);
  assert.equal(parseFrontmatter(await fsa.readFile("out/out.md")).body, "");

  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "tent-scaffold-workspace-"));
  const workspaceFs = new NodeFs(workspace);
  await scaffoldInWorkspace(workspaceFs, {
    name: "workspace",
    nodes: [{ name: "root", type: "goal" }],
  });
  assert.equal(parseFrontmatter(await workspaceFs.readFile(".tent/root/root.md")).body, "");

  const emptyDir = await fs.mkdtemp(path.join(testScratchRoot(), "tent-scaffold-empty-"));
  const emptyFs = new NodeFs(emptyDir);
  await scaffoldTent(emptyFs, { name: "empty" });
  assert.deepEqual((await loadTent(emptyFs)).roots, []);
  assert.equal(await fsa.exists("temp/temp.md"), false);
  assert.match(await fsa.readFile("index.md"), /okf_version: "0.2"/);
  assert.equal(await fsa.exists("SPEC.md"), false);
  assert.equal(await fsa.exists("CLAUDE.md"), false);
  assert.equal(await fsa.exists("AGENTS.md"), false);
  assert.equal(await fsa.exists(".claude"), false);
  assert.equal(await fsa.exists("skills.json"), false);
  assert.equal(await fsa.exists(".tent/skills.json"), false);
  assert.equal(await fsa.exists("roles.json"), false);
  assert.equal(await workspaceFs.exists(".tent/roles.json"), false);
  assert.equal(await fsa.exists("tags.json"), false);
  assert.equal(await fsa.exists("types.json"), false);
  assert.equal(
    await fsa.exists(".gitignore"),
    false,
    "system-root scaffold 不写 workspace gitignore",
  );

  const invalidDir = await fs.mkdtemp(path.join(testScratchRoot(), "tent-scaffold-invalid-"));
  await assert.rejects(
    () => scaffoldTent(new NodeFs(invalidDir), { name: "" }),
    /Tent name cannot be empty\./,
  );
});

test("tags frontmatter:数组往返且键序在 type 后", async () => {
  const body = "# 节点\n";
  const raw = serializeFrontmatter(
    {
      id: "node-tagged",
      type: "prompt-reference",
      tags: ["backend-hardening", "needs,quote"],
      owner: "reviewer",
    },
    body,
    NODE_FRONTMATTER_KEY_ORDER,
  );

  assert.match(
    raw,
    /type: prompt-reference\ntags: \[backend-hardening, "needs,quote"\]\nowner: reviewer/,
  );
  const parsed = parseFrontmatter(raw);
  assert.deepEqual(parsed.data.tags, ["backend-hardening", "needs,quote"]);
  assert.equal(parsed.data.owner, "reviewer");
  assert.equal(parsed.body, body);
});

test("frontmatter round-trip:quoted Windows path does not double escape", () => {
  let raw = String.raw`---
id: node-path
type: output
workspace: "C:\\example\\_code\\Tent"
---
# Workspace
`;

  for (let i = 0; i < 3; i++) {
    const parsed = parseFrontmatter(raw);
    assert.equal(parsed.data.workspace, String.raw`C:\example\_code\Tent`);
    raw = serializeFrontmatter(parsed.data, parsed.body, parsed.keyOrder);
  }

  assert.match(raw, /workspace: "C:\\\\example\\\\_code\\\\Tent"/);
  assert.doesNotMatch(raw, /workspace: "C:\\\\\\\\example/);
});

test("frontmatter round-trip: nested multiline and control strings are always quoted", () => {
  const objective = "第一行\n第二行\t继续\r第三行";
  const raw = serializeFrontmatter(
    {
      type: "task",
      contextCard: {
        schemaVersion: "v1",
        objective,
        acceptance: [objective],
      },
    },
    "# Task\n",
  );

  const frontmatter = raw.slice(0, raw.indexOf("\n---\n", 4));
  assert.doesNotMatch(frontmatter, /\n第二行/);
  assert.match(frontmatter, /objective: "第一行\\n第二行\\t继续\\r第三行"/);
  const parsed = parseFrontmatter(raw);
  const card = parsed.data.contextCard as {
    objective: string;
    acceptance: string[];
  };
  assert.equal(card.objective, objective);
  assert.deepEqual(card.acceptance, [objective]);
});

test("frontmatter round-trip: nested report hashes are not inline comments", () => {
  const report = "body { color: #fff; }\n# Final report";
  const raw = serializeFrontmatter(
    {
      type: "task",
      statusDetail: { kind: "failed", report, error: "marker missing" },
    },
    "# Task\n",
  );

  const parsed = parseFrontmatter(raw);
  assert.equal((parsed.data.statusDetail as { report: string }).report, report);
  assert.equal(parseFrontmatter("---\nlabel: value # comment\n---\n").data.label, "value");
});

test("frontmatter parse: incomplete flow mapping fails loud on the first line", () => {
  assert.throws(
    () =>
      parseFrontmatter(`---
type: task
contextCard: {schemaVersion: v1, objective: 没有闭合
state: queued
---
# Task
`),
    /unterminated flow mapping/,
  );
});

test("frontmatter parse: incomplete flow array fails loud on the first line", () => {
  assert.throws(
    () =>
      parseFrontmatter(`---
type: task
commits: [abc123
state: queued
---
# Task
`),
    /unterminated flow array/,
  );
});

test("frontmatter round-trip:Obsidian block sequences are preserved as arrays", () => {
  const raw = String.raw`---
id: node-paths
type: output
paths:
  - test/a.ts
  - "C:\\example\\_code\\Tent\\src\\core\\frontmatter.ts"
custom: keep-me
---
# Paths
`;
  const parsed = parseFrontmatter(raw);
  assert.deepEqual(parsed.data.paths, [
    "test/a.ts",
    String.raw`C:\example\_code\Tent\src\core\frontmatter.ts`,
  ]);
  assert.equal(parsed.data.custom, "keep-me");

  const out = serializeFrontmatter(
    { ...parsed.data, type: "prompt" },
    parsed.body,
    parsed.keyOrder,
  );
  const reparsed = parseFrontmatter(out);
  assert.deepEqual(reparsed.data.paths, parsed.data.paths);
  assert.equal(reparsed.data.custom, "keep-me");
  assert.equal(reparsed.data.type, "prompt");
});

test("unknown workspace metadata preserves exact path characters", () => {
  const parsed = parseFrontmatter(String.raw`---
id: node-damaged
type: output
workspace: "C:\\\\example\\\\_code\\\\Tent"
---
`);
  assert.equal(parsed.data.workspace, String.raw`C:\\example\\_code\\Tent`);
});

test("tags are derived from Node documents and unchanged edits keep the bytes", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  await fsa.writeFile("tags.json", "{legacy-user-bytes}");
  await saveTags(fsa, "node-p1", ["backend-hardening"]);
  await saveTags(fsa, "node-o1", ["backend-hardening"]);
  const note = "output/alpha仓库指针/alpha仓库指针.md";
  const before = await fsa.readFile(note);
  await saveTags(fsa, "node-o1", ["backend-hardening"]);
  assert.equal(await fsa.readFile(note), before);
  let tent = await loadTent(fsa);
  assert.deepEqual(collectNodeTags(tent), ["backend-hardening"]);
  assert.deepEqual(
    findNodesByTag(tent, "backend-hardening").map((node) => node.id),
    ["node-o1", "node-p1"],
  );
  await saveTags(fsa, "node-p1", []);
  tent = await loadTent(fsa);
  assert.deepEqual(
    findNodesByTag(tent, "backend-hardening").map((node) => node.id),
    ["node-o1"],
  );
  assert.equal(await fsa.readFile("tags.json"), "{legacy-user-bytes}");
});

test("Node write tags change only the document", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  await saveTags(fsa, "node-p1", ["from-write"]);
  assert.deepEqual(collectNodeTags(await loadTent(fsa)), ["from-write"]);
  await saveTags(fsa, "node-p1", []);
  assert.deepEqual(collectNodeTags(await loadTent(fsa)), []);
  assert.equal(await fsa.exists("tags.json"), false);
});

test("legacy tags.json bytes are ignored and preserved", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  await fsa.writeFile("tags.json", "{not-json");
  await saveTags(fsa, "node-p1", ["fresh"]);
  assert.deepEqual(collectNodeTags(await loadTent(fsa)), ["fresh"]);
  assert.equal(await fsa.readFile("tags.json"), "{not-json");
});

test("corrupt order registry is backed up and reset to default order", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  await fs.writeFile(path.join(dir, "order.json"), "{not-json", "utf8");

  const warnings = await captureConsoleError(async () => {
    const { createNode } = await import("../src/core/ops.js");
    await createNode(
      {
        fs: fsa,
        clock: { now: () => "t" },
        tentName: "wqb",
      } as any,
      { parentPath: "", name: "AfterBadOrder", type: "goal" },
    );
  });

  assert.match(warnings.join("\n"), /order\.json was corrupt; backed up to order\.json\.corrupt-/);
  assert.match(warnings.join("\n"), /and recovered\. Review it\./);
  assert.equal(
    (await fs.readdir(dir)).some((name) => name.startsWith("order.json.corrupt-")),
    true,
  );
  assert.equal((await loadTent(fsa)).byPath.has("AfterBadOrder"), true);
});

async function captureConsoleError(action: () => Promise<void>): Promise<string[]> {
  const original = console.error;
  const messages: string[] = [];
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };
  try {
    await action();
  } finally {
    console.error = original;
  }
  return messages;
}
