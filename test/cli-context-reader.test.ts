import { captureFixtureDocuments } from "./scratch.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";
import { initializeFixtureHistory } from "./scratch.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/base/frontmatter.js";
import { nodeReadMaterials } from "../src/cli/read-paths.js";
import { runCardCommand } from "../src/cli/card-commands.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { testScratchRoot } from "./scratch.js";

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

test("Card reads preserve paging, sources and frozen Node metadata", async (t) => {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "cli-reader-"));
  t.after(() =>
    removeTestFixture(root, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 200,
    }),
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
    const filename = path.join(workspace, ".tent/A/A.md");
    const native = parseFrontmatter(await fs.readFile(filename, "utf8"));
    await fs.writeFile(
      filename,
      serializeFrontmatter({ ...native.data, tags: ["offline", "PDF"] }, native.body),
    );
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
          JSON.stringify({
            resource: "https://example.invalid/" + "a".repeat(30000),
          }),
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
    const current = parseFrontmatter(await fs.readFile(filename, "utf8"));
    await fs.writeFile(
      filename,
      serializeFrontmatter({ ...current.data, tags: ["online", "PDF"] }, current.body),
    );
    const adapter = openTestFs(path.join(workspace, ".tent"));
    const frozen = parseFrontmatter(await adapter.history.read(version));
    assert.equal(frozen.body.slice(0, 2), "😀");
    assert.deepEqual(frozen.data.tags, ["offline", "PDF"]);
    assert.deepEqual(parseFrontmatter(await fs.readFile(filename, "utf8")).data.tags, [
      "online",
      "PDF",
    ]);
    assert.equal(
      (await runCardCommand("context", ["relations", cardId, "node-readera"], globals)).exitCode,
      1,
    );
  }
});
