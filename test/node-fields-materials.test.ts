import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { materialCoverage, materialCoverageContains } from "../src/core/base/material-coverage.js";
import { materialOccurrences, validateMaterialAddresses } from "../src/core/base/material.js";
import { assertNodeFields } from "../src/core/graph/node-document-write.js";
import { canonicalIdentityError, loadTent } from "../src/core/store/tree.js";
import { createNode } from "../src/core/graph/ops.js";
import { nodeWriteBatchInputSchema } from "../src/core/write/node-write-batch.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/base/frontmatter.js";
import { checkWorkspaceModules } from "../src/core/check/workspace-module-map.js";
import { draftWorkspaceModules } from "../src/core/check/workspace-draft.js";
import { repositoryFacts } from "../src/core/base/repository-facts.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { testScratchRoot } from "./scratch.js";
import { saveNodesBatch } from "./node-edit.js";

const root = path.resolve(".scratch/material-coverage-domain");
const owner = "Node/Node.md";

test("material membership is shared by file, chapter, directory and trailing-prefix addresses", () => {
  const file = materialCoverage("../../src/a.ts", owner, root)!;
  assert.deepEqual(file, { kind: "file", prefix: "src/a.ts" });
  assert.equal(materialCoverageContains(file, "src/a.ts"), true);
  assert.equal(materialCoverageContains(file, "src/a.ts.more"), false);
  assert.deepEqual(materialCoverage("../../src/a.ts#Part", owner, root), file);
  assert.deepEqual(materialCoverage("child/../../../src/a.ts", owner, root, false), file);
  assert.deepEqual(materialCoverage("../../src/", owner, root), {
    kind: "directory",
    prefix: "src/",
  });
  assert.deepEqual(materialCoverage("../../src/a*", owner, root), {
    kind: "prefix",
    prefix: "src/a",
  });
  for (const resource of ["../../.tent/", "https://example.com/a", "interviews"])
    assert.equal(materialCoverage(resource, owner, root), undefined);
});

test("source track has no material projection or address semantics; other extension fields stay opaque", () => {
  const fields = { sources: [{ resource: "../../src/a.ts", track: "anything", custom: true }] };
  assert.deepEqual(materialOccurrences(fields), [
    { field: "sources", index: 0, resource: "../../src/a.ts" },
  ]);
  assert.doesNotThrow(() => validateMaterialAddresses(fields, owner));
  for (const field of ["sha256", "resource_sha256"])
    assert.throws(() => assertNodeFields({ sources: [{ resource: "./a", [field]: "hash" }] }), {
      message: `Source field ${field} is retired; remove it from the document`,
    });
});

test("Node description is optional text and creation accepts it in single and batch inputs", async (t) => {
  assert.equal(
    canonicalIdentityError({ id: "node-a", type: "goal", description: 1 }),
    "Node description must be a string",
  );
  assert.equal(
    canonicalIdentityError({ id: "node-a", type: "goal", description: "One sentence." }),
    undefined,
  );
  assert.equal(
    nodeWriteBatchInputSchema.safeParse({
      items: [{ op: "create", ref: "a", name: "A", type: "goal", description: 1 }],
    }).success,
    false,
  );
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "node-description-"));
  t.after(() => removeTestFixture(workspace, { recursive: true, force: true }));
  await scaffoldInWorkspace(openTestFs(workspace), { name: "Description" });
  const adapter = openTestFs(path.join(workspace, ".tent"));
  const env = {
    fs: adapter,
    clock: { now: () => "2026-11-03T00:00:00Z" },
    tentName: "Description",
  };
  await createNode(env, {
    parentPath: "",
    name: "One",
    type: "prompt",
    description: "One sentence.",
  });
  await saveNodesBatch(env, {
    items: [
      { op: "create", ref: "b", name: "Two", type: "output", description: "A second sentence." },
    ],
  });
  assert.equal(
    parseFrontmatter(await adapter.readFile("One/One.md")).data.description,
    "One sentence.",
  );
  assert.equal(
    parseFrontmatter(await adapter.readFile("Two/Two.md")).data.description,
    "A second sentence.",
  );
  await adapter.writeFile(
    "One/One.md",
    serializeFrontmatter({ id: "node-bad", type: "prompt", description: false }, "Body"),
  );
  assert.equal(
    (await loadTent(adapter)).byPath.get("One")?.invalidReason,
    "Node description must be a string",
  );
});

test("module report takes goals as parts and does not inherit child prompt rules", async (t) => {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "module-materials-"));
  t.after(() => removeTestFixture(workspace, { recursive: true, force: true }));
  await scaffoldInWorkspace(openTestFs(workspace), { name: "Coverage" });
  const adapter = openTestFs(path.join(workspace, ".tent"));
  const files = Array.from(
    { length: 24 },
    (_, i) => `a/${i < 12 ? "first" : "second"}-${i % 12}.ts`,
  ).concat(["b.ts", "c.ts"]);
  for (const [name, type, resource] of [
    ["A", "goal", "../../a/"],
    ["B", "prompt", "../../b.ts"],
    ["C", "output", "../../c.ts#Part"],
  ])
    await adapter.writeFile(
      `${name}/${name}.md`,
      serializeFrontmatter({ id: `node-${name}`, type, sources: [{ resource }] }, ""),
    );
  await adapter.writeFile(
    "A/Rules/Rules.md",
    serializeFrontmatter({ id: "node-rules", type: "prompt" }, "allow:part.oversized"),
  );
  const result = await checkWorkspaceModules(adapter, workspace, {
    head: null,
    trackedFiles: files,
    commits: [],
    sources: { files: [], errors: [] },
  });
  assert.deepEqual(
    result.partFacts.map(({ name }) => name),
    ["A"],
  );
  assert.deepEqual(
    result.issues
      .filter(({ code }) => code === "map.uncovered")
      .flatMap(({ facts }) => facts.files ?? []),
    ["b.ts", "c.ts"],
  );
  assert.equal(
    result.issues.some(({ code }) => code === "part.oversized"),
    true,
  );
  const draft = draftWorkspaceModules({
    head: null,
    coverage: {
      trackedFiles: files.length,
      coveredFiles: 0,
      uncoveredFiles: files,
      directories: [],
    },
    inspectionErrors: [],
    ...repositoryFacts(files.map((path) => ({ path }))),
  });
  assert.equal(JSON.stringify(draft).includes('"track"'), false);
});

test("workspace check reports retired Node verified while source extension metadata remains opaque", async (t) => {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "node-verified-"));
  t.after(() => removeTestFixture(workspace, { recursive: true, force: true }));
  await scaffoldInWorkspace(openTestFs(workspace), { name: "Verified" });
  const adapter = openTestFs(path.join(workspace, ".tent"));
  const data = {
    id: "node-retired",
    type: "prompt",
    verified: false,
    sources: [{ resource: "customer discussion", verified: true, custom: "kept" }],
  };
  await adapter.writeFile("Retired/Retired.md", serializeFrontmatter(data, "Facts"));
  const { runWorkspaceCommand } = await import("../src/cli/workspace-commands.js");
  const result = await runWorkspaceCommand("check", ["--json"], { workspace });
  assert.equal(result.exitCode, 1);
  assert.ok(
    JSON.parse(result.stdout).errors.some((error: { reason: string }) =>
      error.reason.includes("Node field verified is retired; remove it from the document"),
    ),
  );
  assert.throws(() => assertNodeFields(data), {
    message: "Node field verified is retired; remove it from the document",
  });
  assert.equal(canonicalIdentityError({ ...data, verified: undefined }), undefined);
});
