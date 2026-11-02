import { openTestFs, removeTestFixture } from "./node-fs.js";
import { initializeFixtureHistory } from "./scratch.js";
import { testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { nodeMaterialWarnings } from "../src/core/graph/node-material-warnings.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { git } from "./helpers.js";
import { parseFrontmatter } from "../src/core/base/frontmatter.js";

test("whole Markdown advice uses real sibling sections and only newly added whole materials", async () => {
  const multi = "---\nlabel: ignored\n---\n# Guide\n## One\ntext\n## Two\ntext\n";
  let reads = 0;
  const adapter = {
    readMaterialText: async () => {
      reads++;
      return multi;
    },
  };
  const data = { id: "node-rule", type: "goal", sources: [{ resource: "../../guide.md" }] };
  assert.equal((await nodeMaterialWarnings(adapter, data, "Rule/Rule.md")).length, 1);
  reads = 0;
  assert.deepEqual(await nodeMaterialWarnings(adapter, data, "Rule/Rule.md", data), []);
  assert.equal(reads, 0);
  const selected = { ...data, sources: [{ resource: "../../guide.md#One" }] };
  assert.deepEqual(await nodeMaterialWarnings(adapter, selected, "Rule/Rule.md"), []);
  assert.equal((await nodeMaterialWarnings(adapter, data, "Rule/Rule.md", selected)).length, 1);
  for (const body of [
    "# Only title\n",
    "# Title\n## One\n### Child\n",
    "# Title\n```md\n## Fake\n## Fake2\n```\n",
    "> ## Quote\n> ## Quote2\n",
  ]) {
    assert.deepEqual(
      await nodeMaterialWarnings({ readMaterialText: async () => body }, data, "Rule/Rule.md"),
      [],
    );
  }
  assert.equal(
    (
      await nodeMaterialWarnings(
        { readMaterialText: async () => "Title\n=====\nOne\n---\nTwo\n---\n" },
        data,
        "Rule/Rule.md",
      )
    ).length,
    1,
  );
  for (const resource of [
    "https://example.org/a.md",
    "../../a.txt",
    "../../src/",
    "../../src/a*",
  ]) {
    assert.deepEqual(
      await nodeMaterialWarnings(adapter, { ...data, sources: [{ resource }] }, "Rule/Rule.md"),
      [],
    );
  }
  assert.deepEqual(
    await nodeMaterialWarnings(adapter, { ...data, type: "output" }, "Rule/Rule.md"),
    [],
  );
  assert.deepEqual(
    await nodeMaterialWarnings(
      {
        readMaterialText: async () => {
          throw Error("missing");
        },
      },
      data,
      "Rule/Rule.md",
    ),
    [],
  );
});

test("CLI write and batch receipts do not repeat whole-document advice", async (t) => {
  const { root } = await fixture(t);
  await fs.writeFile(path.join(root, "tracked.md"), "# Guide\n## One\nA\n## Two\nB\n");
  const command = async (sub: string, args: string[], input?: unknown) => {
    const r = await runNodeCommand(sub, args, {
      workspace: root,
      json: true,
      ...(input === undefined ? {} : { stdin: JSON.stringify(input) }),
    });
    assert.equal(r.exitCode, 0, r.stderr || r.stdout);
    return JSON.parse(r.stdout);
  };
  const created = await command("create", ["Whole", "--type", "goal", "--resource", "tracked.md"]);
  assert.match(created.warnings[0], /whole document with several sections/);
  const id = created.node.nodeId;
  await fs.appendFile(path.join(root, "tracked.md"), "Changed\n");
  const before = await command("get", [id, "--full"]);
  const saved = await command("write", [id, "--input-json", "-"], {
    baseEtag: before.etag,
    body: "New wording",
  });
  assert.equal(saved.warnings, undefined);
  const latest = await command("get", [id, "--full"]);
  const batch = await command("write-many", ["--input-json", "-"], {
    items: [
      { op: "update", nodeId: id, baseEtag: latest.etag, body: "Batch wording" },
      { op: "create", ref: "new", name: "New", type: "prompt", resource: "tracked.md" },
    ],
  });
  assert.equal(batch.warnings.length, 1);
  assert.match(batch.warnings[0], /whole document with several sections/);
  const forward = await command("write-many", ["--input-json", "-"], {
    items: [
      {
        op: "create",
        ref: "consumer",
        name: "Consumer",
        type: "goal",
        sources: [{ resource: "@document" }],
      },
      {
        op: "create",
        ref: "document",
        name: "Document",
        type: "output",
        body: "# Document\n## First\nA\n## Second\nB\n",
      },
    ],
  });
  assert.equal(forward.warnings.length, 1);
  assert.match(forward.warnings[0], /whole document with several sections/);
});

async function fixture(t: TestContext) {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "material-warning-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await scaffoldInWorkspace(openTestFs(root), { name: "Warnings" });
  await git(root, "init", "--quiet");
  await initializeFixtureHistory(path.join(root, ".tent"));
  await fs.writeFile(path.join(root, ".gitignore"), "report.md\n.tent/\n");
  await fs.writeFile(path.join(root, "report.md"), "Report one\n");
  await fs.writeFile(path.join(root, "tracked.md"), "Tracked rule\n");
  await git(root, "add", "tracked.md");
  return { root, adapter: openTestFs(path.join(root, ".tent")) };
}
