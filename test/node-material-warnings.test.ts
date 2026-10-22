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

test("CLI write and batch receipts do not repeat whole-document advice or reset a baseline", async (t) => {
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
  const initial = await command("check", [id]);
  await fs.appendFile(path.join(root, "tracked.md"), "Changed\n");
  const before = await command("get", [id, "--full"]);
  const saved = await command("write", [id, "--input-json", "-"], {
    baseEtag: before.etag,
    body: "New wording",
  });
  assert.equal(saved.warnings, undefined);
  const after = await command("check", [id]);
  assert.ok(after.behind);
  assert.equal(after.materials[0].recordedVersion, initial.materials[0].recordedVersion);
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

test("advice distinguishes untracked files from unknown observations and other addresses", async () => {
  const calls: string[] = [];
  const adapter = {
    materialIsTracked: async (resource: string) => {
      calls.push(resource);
      if (resource.includes("unknown")) throw new Error("Git unavailable");
      return resource.includes("tracked.md");
    },
  };
  const data = {
    id: "node-rule",
    type: "prompt",
    resource: "../../report.md",
    sources: [
      { resource: "../../report.md" },
      { resource: "../../tracked.md#Rule" },
      { resource: "../../unknown.md" },
      { resource: "../../src/" },
      { resource: "../../src/a*" },
      { resource: "https://example.org/a" },
      { resource: "External discussion" },
      { resource: "../Other/Other.md" },
    ],
  };
  const warnings = await nodeMaterialWarnings(adapter, data, "Rule/Rule.md");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /node-rule:.*not tracked by Git.*as output/);
  assert.match(warnings[0]!, /report\.md/);
  assert.doesNotMatch(warnings[0]!, /tracked\.md|unknown\.md/);
  assert.deepEqual(calls, ["../../report.md", "../../tracked.md#Rule", "../../unknown.md"]);
  calls.length = 0;
  for (const type of ["output", undefined])
    assert.deepEqual(await nodeMaterialWarnings(adapter, { ...data, type }, "Rule/Rule.md"), []);
  assert.deepEqual(calls, []);
  assert.deepEqual(await nodeMaterialWarnings({}, data, "Rule/Rule.md"), []);
});

async function fixture(t: TestContext) {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "material-warning-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  await scaffoldInWorkspace(new NodeFs(root), { name: "Warnings" });
  await git(root, "init", "--quiet");
  await git(path.join(root, ".tent"), "init", "--quiet");
  await fs.writeFile(path.join(root, ".gitignore"), "report.md\n.tent/\n");
  await fs.writeFile(path.join(root, "report.md"), "Report one\n");
  await fs.writeFile(path.join(root, "tracked.md"), "Tracked rule\n");
  await git(root, "add", "tracked.md");
  return { root, adapter: new NodeFs(path.join(root, ".tent")) };
}

test("tracking reads literal index membership and file URIs without changing Git", async (t) => {
  const { root, adapter } = await fixture(t);
  await fs.writeFile(path.join(root, "a[1].md"), "literal\n");
  await fs.writeFile(path.join(root, "a1.md"), "different\n");
  await git(root, "add", "a1.md");
  const index = await fs.readFile(path.join(root, ".git/index"));
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(root, ".tent/.git");
  try {
    assert.equal(await adapter.materialIsTracked("../../tracked.md", "Rule/Rule.md"), true);
    assert.equal(await adapter.materialIsTracked("../../report.md", "Rule/Rule.md"), false);
    assert.equal(await adapter.materialIsTracked("../../a[1].md", "Rule/Rule.md"), false);
    assert.equal(
      await adapter.materialIsTracked(
        pathToFileURL(path.join(root, "tracked.md")).href,
        "Rule/Rule.md",
      ),
      true,
    );
    assert.equal(await adapter.materialIsTracked("../../", "Rule/Rule.md"), undefined);
    assert.equal(
      await adapter.materialIsTracked("https://example.org/a", "Rule/Rule.md"),
      undefined,
    );
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  }
  assert.deepEqual(await fs.readFile(path.join(root, ".git/index")), index);
  assert.equal(await fs.readFile(path.join(root, "report.md"), "utf8"), "Report one\n");
});

test("write receipts advise without changing types or accepting new material baselines", async (t) => {
  const { root } = await fixture(t);
  const command = async (sub: string, args: string[], stdin?: unknown, json = true) => {
    const result = await runNodeCommand(sub, args, {
      workspace: root,
      json,
      ...(stdin === undefined ? {} : { stdin: JSON.stringify(stdin) }),
    });
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    return json ? JSON.parse(result.stdout) : result.stdout;
  };
  const created = await command("create", [
    "Rule",
    "--type",
    "goal",
    "--resource",
    "report.md",
    "--body",
    "Rule still holds",
  ]);
  const id = created.node.nodeId;
  assert.equal(created.warnings.length, 1);
  const initial = await command("check", [id]);
  const before = await command("get", [id, "--full"]);
  await fs.writeFile(path.join(root, "report.md"), "Report two\n");
  const saved = await command("write", [id, "--input-json", "-"], {
    baseEtag: before.etag,
    body: "Updated wording",
    readBack: true,
  });
  assert.equal(saved.warnings.length, 1);
  assert.equal(saved.readBack.text, "Updated wording");
  assert.equal(
    parseFrontmatter(await fs.readFile(path.join(root, created.node.path), "utf8")).data.type,
    "goal",
  );
  const after = await command("check", [id]);
  assert.ok(after.behind);
  assert.equal(after.materials[0].recordedVersion, initial.materials[0].recordedVersion);
  assert.notEqual(after.materials[0].currentVersion, initial.materials[0].currentVersion);
  const text = await command("append", [id, "--body", "Another sentence"], undefined, false);
  assert.equal(text.split("not tracked by Git").length - 1, 1);
  assert.doesNotMatch(
    await fs.readFile(path.join(root, created.node.path), "utf8"),
    /not tracked by Git/,
  );
  const tracked = await command("create", [
    "Tracked",
    "--type",
    "prompt",
    "--resource",
    "tracked.md",
  ]);
  assert.equal("warnings" in tracked, false);
  const output = await command("create", ["Result", "--type", "output", "--resource", "report.md"]);
  assert.equal("warnings" in output, false);
  const current = await command("get", [id, "--full"]);
  const textWrite = await command(
    "write",
    [id, "--body", "Readback wording", "--base-etag", current.etag, "--read-back"],
    undefined,
    false,
  );
  assert.equal(textWrite.split("not tracked by Git").length - 1, 1);
  const latest = await command("get", [id, "--full"]);
  const batch = await command("write-many", ["--input-json", "-"], {
    items: [
      { op: "update", nodeId: id, baseEtag: latest.etag, body: "Batch wording" },
      { op: "create", ref: "result", name: "Batch result", type: "output", resource: "report.md" },
      { op: "create", ref: "rule", name: "Batch rule", type: "prompt", resource: "report.md" },
    ],
  });
  assert.equal(batch.warnings.length, 2);
  assert.equal(batch.results.length, 3);
  assert.ok(batch.commit);
  assert.equal(
    (await command("check", [id])).materials[0].recordedVersion,
    initial.materials[0].recordedVersion,
  );
});
