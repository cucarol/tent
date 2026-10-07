import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { runCardCommand } from "../src/cli/card-commands.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { git } from "./helpers.js";
import { NodeFs } from "../src/fs/node-fs.js";

test("CLI exposes bounded live and frozen readers without losing pages, ranges or sources", async (t) => {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "cli-reader-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  const workspace = path.join(root, "workspace");
  const body = "😀reader fidelity\n" + "正文".repeat(12000) + "\n[B](../B/B.md)\n";
  await scaffoldInWorkspace(new NodeFs(workspace), {
    name: "CLI reader",
    nodes: [
      { id: "node-readera", name: "A", type: "prompt", body },
      { id: "node-readerb", name: "B", type: "output", body: "reader peer" },
    ],
  });
  {
    const globals = { workspace, json: true };
    const parse = (result: { exitCode: number; stdout: string; stderr: string }) => {
      assert.equal(result.exitCode, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const node = async (sub: string, args: string[]) =>
      parse(await runNodeCommand(sub, args, globals));
    await node("tags", [
      "set",
      "node-readera",
      "offline,PDF",
      "--base-etag",
      (await node("get", ["node-readera", "--full"])).node.etag,
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
      assert.equal(read.node.source.kind, "live");
      text += read.node.text;
      cursor = read.node.page.nextCursor;
    } while (cursor);
    assert.equal(text, full.node.text);
    const summary = await node("get", ["node-readera", "--view", "summary"]);
    assert.equal("text" in summary.node, false);
    assert.deepEqual(summary.node.tags, ["offline", "PDF"]);
    const range = JSON.stringify({ unit: "utf16", start: 0, end: 2 });
    assert.equal(
      (await node("get", ["node-readera", "--range", range, "--expected-etag", full.node.etag]))
        .node.text,
      "😀",
    );
    const raw = await node("get", ["node-readera", "--view", "raw"]);
    assert.match(raw.node.text, /^---/);
    await node("write", [
      "node-readera",
      "--input-json",
      JSON.stringify({
        baseEtag: (await node("get", ["node-readera", "--full"])).node.etag,
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
    await git(path.join(workspace, ".tent"), "init");
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
    await node("tags", [
      "set",
      "node-readera",
      "online,PDF",
      "--base-etag",
      (await node("get", ["node-readera", "--full"])).node.etag,
    ]);
    assert.deepEqual((await node("get", ["node-readera", "--view", "summary"])).node.tags, [
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
    assert.equal(frozen.node.text, "😀");
    assert.deepEqual(frozen.node.tags, ["offline", "PDF"]);
    assert.equal(frozen.node.source.kind, "git");
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
