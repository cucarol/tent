import { captureFixtureDocuments } from "./scratch.js";
import { captureReadDocuments } from "../src/core/store/document-history.js";
import { loadNodeCatalog } from "../src/core/graph/node-catalog.js";
import { nodeNotePath } from "../src/core/base/paths.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";
import { initializeFixtureHistory } from "./scratch.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { nodeReadMaterials } from "../src/cli/read-paths.js";
import { runCardCommand } from "../src/cli/card-commands.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { git } from "./helpers.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { createNode } from "../src/core/graph/ops.js";
import { writeNodeDocument } from "../src/core/graph/node-document-write.js";
import { readNodeForEdit } from "../src/core/read/node-query.js";
import { initializeFixtureWorkspace, testScratchRoot } from "./scratch.js";

test("material display preserves directory and prefix selectors without opening files", () => {
  assert.deepEqual(
    nodeReadMaterials(
      {
        resource: "../../output/missing%20file.md#Heading",
        sources: [
          { resource: "../../src/" },
          { resource: "../../src/node-*" },
          { resource: "../../" },
          {
            resource: pathToFileURL(
              path.resolve(testScratchRoot(), "nonexistent-material-display", "src") + path.sep,
            ).href,
          },
          { resource: "https://example.com/doc" },
          { resource: "conversation" },
        ],
      },
      "Owner",
      path.resolve(testScratchRoot(), "nonexistent-material-display"),
    ),
    [
      "output/missing file.md",
      "src/",
      "src/node-*",
      "./",
      "src/",
      "https://example.com/doc",
      "conversation",
    ],
  );
});

test("node get preserves foreign file URIs when the host cannot map them", async (t) => {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "cli-foreign-material-"));
  t.after(() =>
    removeTestFixture(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await initializeFixtureWorkspace(workspace);
  const resource =
    process.platform === "win32" ? "file:///home/example/report.md" : "file://other-host/report.md";
  const created = await runNodeCommand(
    "create",
    ["Foreign", "--type", "prompt", "--resource", resource, "--body", "Body remains readable"],
    { workspace, json: true },
  );
  assert.equal(created.exitCode, 0, created.stderr);
  const nodeId = JSON.parse(created.stdout).node.nodeId;
  const adapter = openTestFs(path.join(workspace, ".tent"));
  const head = await adapter.history.currentCommit();
  for (const flags of [[], ["--full"], ["--view", "raw"], ["--full", "--view", "raw"]]) {
    const read = await runNodeCommand("get", [nodeId, ...flags], { workspace, json: true });
    assert.equal(read.exitCode, 0, read.stderr);
    const value = JSON.parse(read.stdout);
    assert.deepEqual(value.materials, [resource]);
    assert.match(value.text, /Body remains readable/);
    const text = await runNodeCommand("get", [nodeId, ...flags], { workspace });
    assert.equal(text.exitCode, 0, text.stderr);
    assert.ok(text.stdout.includes(`Material: ${resource}\n`));
  }
  assert.equal(await adapter.history.currentCommit(), head);
});

test("node get shows decoded own material paths below ETag even with an empty body", async (t) => {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "cli-material-paths-"));
  t.after(() =>
    removeTestFixture(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await initializeFixtureWorkspace(workspace);
  const adapter = openTestFs(path.join(workspace, ".tent"));
  const env = {
    fs: adapter,
    clock: { now: () => "2026-10-22T00:00:00.000Z" },
    tentName: "Materials",
  };
  await fs.mkdir(path.join(workspace, "output", "资料"), { recursive: true });
  await fs.writeFile(path.join(workspace, "output", "资料", "report.md"), "PRIVATE MATERIAL BODY");
  await fs.writeFile(path.join(workspace, "source note.md"), "PRIVATE SOURCE BODY");
  await createNode(env, { parentPath: "", name: "Parent", type: "goal" });
  const id = await createNode(env, {
    parentPath: "Parent",
    name: "Empty",
    type: "output",
    body: "",
    resource: "../../../output/%E8%B5%84%E6%96%99/report.md",
    sources: [{ resource: "../../../source%20note.md" }],
  });
  const head = await adapter.history.currentCommit();
  const version = { commit: head, path: "Parent/Empty/Empty.md" };
  const expected = ["output/资料/report.md", "source note.md"];
  for (const args of [
    [id],
    [id, "--full"],
    [id, "--view", "raw"],
    [id, "--full", "--view", "raw"],
    [id, "--version-json", JSON.stringify(version)],
  ]) {
    const json = await runNodeCommand("get", args, { workspace, json: true });
    assert.equal(json.exitCode, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout).materials, expected);
    const text = await runNodeCommand("get", args, { workspace });
    assert.equal(text.exitCode, 0, text.stderr);
    assert.match(
      text.stdout,
      /ETag: [^\n]+\nMaterial: output\/资料\/report.md\nMaterial: source note.md\n/,
    );
    assert.doesNotMatch(text.stdout, /PRIVATE MATERIAL BODY|PRIVATE SOURCE BODY/);
  }
  assert.equal(await adapter.history.currentCommit(), head);
});

test("complete output CLI reads expose changedSince in JSON and approved text without saving it", async (t) => {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "cli-output-freeze-"));
  t.after(() =>
    removeTestFixture(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await initializeFixtureWorkspace(workspace);
  const adapter = openTestFs(path.join(workspace, ".tent"));
  const env = {
    fs: adapter,
    clock: { now: () => "2026-10-06T00:00:00.000Z" },
    tentName: "Read output",
  };
  const outer = await createNode(env, { parentPath: "", name: "Outer", type: "goal" });
  const inner = await createNode(env, { parentPath: "Outer", name: "Inner", type: "goal" });
  await fs.writeFile(path.join(workspace, "result.txt"), "before");
  const output = await createNode(env, {
    parentPath: "Outer/Inner",
    name: "Result",
    type: "output",
    body: "Recorded result",
    resource: "../../../../result.txt",
  });
  const version = {
    commit: await adapter.history.currentCommit(),
    path: "Outer/Inner/Result/Result.md",
  };
  for (const id of [outer, inner])
    await writeNodeDocument(adapter, id, {
      baseEtag: (await readNodeForEdit(adapter, id)).etag,
      body: "Changed requirement",
    });
  await fs.writeFile(path.join(workspace, "result.txt"), "after");
  const expected = [
    { kind: "material", resource: "../../../../result.txt" },
    { kind: "goal", nodeId: inner, name: "Inner" },
  ];
  const head = await adapter.history.currentCommit();
  const before = await adapter.readFile(version.path);
  const run = async (sub: string, args: string[], json = true) => {
    const result = await runNodeCommand(sub, args, { workspace, json });
    assert.equal(result.exitCode, 0, result.stderr);
    return json ? JSON.parse(result.stdout) : result.stdout;
  };
  for (const args of [[output], [output, "--full"], [output, "--full", "--view", "raw"]]) {
    assert.deepEqual((await run("get", args)).changedSince, expected);
    const text = await run("get", args, false);
    assert.ok(
      text.includes(
        `Changed since this output was saved or confirmed:\n- material ../../../../result.txt\n- goal Inner (${inner})\nIt still records what it saw then. If a change makes it wrong for current work, record a new output; if it still holds, confirm it.`,
      ),
      text,
    );
  }
  assert.deepEqual((await run("read-many", [output])).items[0].changedSince, expected);
  assert.match(
    await run("read-many", [output], false),
    /Changed since this output was saved or confirmed:/,
  );
  assert.equal((await run("get", [output, "--view", "summary"])).changedSince, undefined);
  assert.equal(
    (await run("get", [output, "--version-json", JSON.stringify(version)])).changedSince,
    undefined,
  );
  assert.equal(await adapter.history.currentCommit(), head);
  assert.equal(await adapter.readFile(version.path), before);
  await run("confirm", [output, "--base-etag", (await run("get", [output, "--full"])).etag]);
  assert.equal((await run("get", [output, "--full"])).changedSince, undefined);
  assert.doesNotMatch(await run("get", [output, "--full"], false), /Changed since/);
});

test("CLI exposes bounded live and frozen readers without losing pages, ranges or sources", async (t) => {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "cli-reader-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  const workspace = path.join(root, "workspace");
  const body = "😀reader fidelity\n" + "正文".repeat(12000) + "\n[B](../B/B.md)\n";
  await scaffoldInWorkspace(openTestFs(workspace), {
    name: "CLI reader",
    nodes: [
      { id: "node-readera", name: "A", type: "prompt", body },
      { id: "node-readerb", name: "B", type: "output", body: "reader peer" },
    ],
  });
  await initializeFixtureHistory(path.join(workspace, ".tent"));
  await captureFixtureDocuments(path.join(workspace, ".tent"));
  {
    const globals = { workspace, json: true };
    const parse = (result: { exitCode: number; stdout: string; stderr: string }) => {
      assert.equal(result.exitCode, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const node = async (sub: string, args: string[]) =>
      parse(await runNodeCommand(sub, args, globals));
    await node("write", [
      "node-readera",
      "--input-json",
      JSON.stringify({
        baseEtag: (await node("get", ["node-readera", "--full"])).etag,
        frontmatter: { tags: ["offline", "PDF"] },
      }),
    ]);
    const first = await node("list", ["--limit", "1"]);
    assert.equal(first.items.length, 1);
    assert.deepEqual(first.items[0].tags, ["offline", "PDF"]);
    assert.equal(first.page.hasMore, true);
    const second = await node("list", ["--limit", "1", "--cursor", first.page.nextCursor]);
    assert.notEqual(first.items[0].nodeId, second.items[0].nodeId);
    assert.equal(second.page.hasMore, false);
    const full = await node("get", ["node-readera", "--full"]);
    let text = "";
    let cursor: string | undefined;
    do {
      const read = await node("get", ["node-readera", ...(cursor ? ["--cursor", cursor] : [])]);
      assert.equal("source" in read, false);
      text += read.text;
      cursor = read.page?.nextCursor;
    } while (cursor);
    assert.equal(text, full.text);
    const summary = await node("get", ["node-readera", "--view", "summary"]);
    assert.equal("text" in summary, false);
    assert.deepEqual(summary.tags, ["offline", "PDF"]);
    const range = JSON.stringify({ unit: "utf16", start: 0, end: 2 });
    assert.equal(
      (await node("get", ["node-readera", "--range", range, "--expected-etag", full.etag])).text,
      "😀",
    );
    const raw = await node("get", ["node-readera", "--view", "raw"]);
    assert.match(raw.text, /^---/);
    await node("write", [
      "node-readera",
      "--input-json",
      JSON.stringify({
        baseEtag: (await node("get", ["node-readera", "--full"])).etag,
        frontmatter: { resource: "src/reader.ts" },
      }),
    ]);
    assert.equal(
      (await node("search", ["--resource", "src/reader.ts"])).items[0].nodeId,
      "node-readera",
    );
    assert.equal(
      (await node("relations", ["node-readerb", "--direction", "incoming"])).items[0].from.nodeId,
      "node-readera",
    );
    assert.equal((await runNodeCommand("backlinks", ["node-readerb"], globals)).exitCode, 1);
    await initializeFixtureHistory(path.join(workspace, ".tent"));
    const created = parse(
      await runCardCommand("create", ["--prompt", "reader", "--source", ".tent/A/A.md"], globals),
    );
    const cardId = created.cardId;
    const savedInput = parse(await runCardCommand("get", [cardId], globals));
    const version = savedInput.sources[0].version;
    assert.equal(version.path, "A/A.md");
    const largeCard = parse(
      await runCardCommand(
        "create",
        [
          "--prompt",
          "large".repeat(25000),
          "--source",
          JSON.stringify({ resource: "https://example.invalid/" + "a".repeat(30000) }),
        ],
        globals,
      ),
    );
    const taken = parse(await runCardCommand("take", [largeCard.cardId], globals));
    assert.equal(taken.page.hasMore, true);
    assert.equal(taken.sourcesOmitted, true);
    assert.ok(Buffer.byteLength(JSON.stringify(taken)) <= 16 * 1024);
    const unqualified = await runCardCommand(
      "get",
      [largeCard.cardId, "--start", "2", "--end", "10"],
      globals,
    );
    assert.equal(unqualified.exitCode, 1);
    assert.match(unqualified.stderr, /expected-etag/);
    await node("write", [
      "node-readera",
      "--input-json",
      JSON.stringify({
        baseEtag: (await node("get", ["node-readera", "--full"])).etag,
        frontmatter: { tags: ["online", "PDF"] },
      }),
    ]);
    assert.deepEqual((await node("get", ["node-readera", "--view", "summary"])).tags, [
      "online",
      "PDF",
    ]);
    const frozen = await node("get", [
      "node-readera",
      "--version-json",
      JSON.stringify(version),
      "--range",
      range,
    ]);
    assert.equal(frozen.text, "😀");
    const frozenMetadata = await node("get", [
      "node-readera",
      "--version-json",
      JSON.stringify(version),
      "--view",
      "summary",
    ]);
    assert.deepEqual(frozenMetadata.tags, ["offline", "PDF"]);
    for (const args of [
      ["--limit", "0"],
      ["--full", "--limit", "1"],
    ]) {
      assert.equal((await runNodeCommand("list", args, globals)).exitCode, 1);
    }
    assert.equal(
      (await runNodeCommand("get", ["node-readera", "--view", "invented"], globals)).exitCode,
      1,
    );
    assert.equal(
      (await runCardCommand("context", ["relations", cardId, "node-readera"], globals)).exitCode,
      1,
    );
  }
});
