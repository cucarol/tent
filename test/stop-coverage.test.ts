import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  formatStopCoverage,
  selectStopCoverage,
  stopCoverageSections,
  type StopCoverageIndex,
} from "../src/core/return/stop-coverage.js";
import { sectionKey, sectionFingerprints } from "../src/core/return/section-fingerprint.js";
import { loadStopCoverage } from "../src/fs/stop-coverage.js";
import { materialCoverageContains } from "../src/core/base/material-coverage-match.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";

async function fixture(t: TestContext) {
  const scratch = fileURLToPath(
    new URL("../.scratch/converge-stop1103/coverage/", import.meta.url),
  );
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "stop-coverage-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  const systemRoot = path.join(root, ".tent");
  await fs.mkdir(path.join(systemRoot, ".git"), { recursive: true });
  await fs.writeFile(path.join(systemRoot, "index.md"), '---\nokf_version: "0.2"\n---\n');
  const adapter = openTestFs(systemRoot);
  const node = async (name: string, metadata: string, body = "secret body") => {
    if (!/(?:^|\n)type:/.test(metadata)) metadata = `type: goal\n${metadata}`;
    await fs.mkdir(path.join(systemRoot, name), { recursive: true });
    await fs.writeFile(
      path.join(systemRoot, name, `${path.basename(name)}.md`),
      `---\nid: node-${name.replaceAll("/", "-")}\n${metadata}\n---\n${body}`,
    );
  };
  const load = () => loadStopCoverage(systemRoot, root, adapter);
  return { root, systemRoot, adapter, node, load };
}
const names = (index: StopCoverageIndex, files: string[], sections?: ReadonlySet<string>) =>
  selectStopCoverage(index, files, sections).map((node) => node.name);

const indexed = (name: string, materials: StopCoverageIndex["nodes"][number]["materials"]) => ({
  nodeId: `node-${name.toLowerCase()}`,
  name,
  path: path.resolve(`.tent/${name}/${name}.md`),
  materials,
});

test("prepared coverage retains shared path validation, directory boundaries and root coverage", () => {
  const declarations = [
    { kind: "directory", prefix: "" },
    { kind: "directory", prefix: "src/" },
    { kind: "prefix", prefix: "src/util" },
    { kind: "file", prefix: "src/exact.ts" },
  ] as const;
  const files = [
    "README.md",
    "src",
    "src/a.ts",
    "src/utils/a.ts",
    "src/utility.ts",
    "src/exact.ts",
    "src-other/a.ts",
    "",
    "/src/a.ts",
    "src\\a.ts",
    "../src/a.ts",
    "./src/a.ts",
    "src//a.ts",
    "src/a.ts/",
    ".tent/A/A.md",
  ];
  for (const declaration of declarations) {
    const material =
      declaration.kind === "file"
        ? { kind: "file" as const, path: declaration.prefix }
        : declaration;
    const index = { nodes: [indexed("Match", [material])] };
    for (const file of files)
      assert.deepEqual(
        names(index, [file]),
        materialCoverageContains(declaration, file) ? ["Match"] : [],
        `${declaration.kind} ${declaration.prefix} / ${file}`,
      );
  }
  assert.deepEqual(names({ nodes: [indexed("Root", [declarations[0]])] }, ["src-other/a.ts"]), [
    "Root",
  ]);
  assert.deepEqual(names({ nodes: [indexed("Root", [declarations[0]])] }, files.slice(7)), []);
  assert.deepEqual(
    names({ nodes: [indexed("Directory", [declarations[1]])] }, ["src", "src-other/a.ts"]),
    [],
  );
  assert.deepEqual(
    names({ nodes: [indexed("Prefix", [declarations[2]])] }, [
      "src/util",
      "src/utils/a.ts",
      "src/utility.ts",
    ]),
    ["Prefix"],
  );
});

test("prepared files and changed sections tie above the longest directory or prefix", () => {
  const index = {
    nodes: [
      indexed("Root", [{ kind: "directory", prefix: "" }]),
      indexed("Directory", [{ kind: "directory", prefix: "docs/" }]),
      indexed("Prefix", [{ kind: "prefix", prefix: "docs/spec" }]),
      indexed("Peer", [{ kind: "prefix", prefix: "docs/spec" }]),
      indexed("Section", [{ kind: "file", path: "docs/spec.md", heading: "Rules" }]),
      indexed("File", [{ kind: "file", path: "docs/spec.md" }]),
    ],
  };
  assert.deepEqual(names(index, ["docs/spec.md"], new Set([sectionKey("docs/spec.md", "Rules")])), [
    "File",
    "Section",
  ]);
  assert.deepEqual(names(index, ["docs/spec.md"]), ["File"]);
  assert.deepEqual(names(index, ["docs/specification.md"]), ["Peer", "Prefix"]);
  assert.deepEqual(names(index, ["docs/another.md"]), ["Directory"]);
  assert.deepEqual(names(index, ["elsewhere.md"]), ["Root"]);
});

test("prepared coverage preserves host case rules and checks section changes per call", () => {
  const index = {
    nodes: [
      indexed("Directory", [{ kind: "directory", prefix: "SRC/" }]),
      indexed("Section", [{ kind: "file", path: "SRC/FILE.md", heading: "Rules" }]),
    ],
  };
  const isWindows = process.platform === "win32";
  assert.deepEqual(names(index, ["src/other.ts"]), isWindows ? ["Directory"] : []);
  assert.deepEqual(
    names(index, ["src/file.md"], new Set([sectionKey("SRC/FILE.md", "Rules")])),
    isWindows ? ["Section"] : [],
  );
  assert.deepEqual(names(index, ["SRC/FILE.md"]), ["Directory"]);
  assert.deepEqual(names(index, ["SRC/FILE.md"], new Set([sectionKey("SRC/FILE.md", "Rules")])), [
    "Section",
  ]);
  assert.deepEqual(
    names({ nodes: [indexed("Root", [{ kind: "directory", prefix: "" }])] }, [".TENT/A/A.md"]),
    isWindows ? [] : ["Root"],
  );
  assert.deepEqual(
    names(
      {
        nodes: [
          indexed("Shorter", [{ kind: "prefix", prefix: "\u0130" }]),
          indexed("Longer", [{ kind: "prefix", prefix: "i\u0307" }]),
        ],
      },
      ["i\u0307-file.ts"],
    ),
    ["Longer"],
    "specificity uses the declaration's length even when case folding changes its length",
  );
});

test("Stop picks files, nearest directories and equally precise declarations regardless of type", async (t) => {
  const f = await fixture(t);
  await f.node("Root", "type: goal\nresource: ../../src/");
  await f.node("Nearest", "type: prompt\nsources: [{resource: ../../src/core/}]");
  await f.node("File", "type: output\nresource: ../../src/core/a.ts");
  await f.node("Peer", "type: goal\nsources: [{resource: ../../src/core/a.ts, track: anything}]");
  await f.node("Prefix", "sources: [{resource: ../../lib/util*}]");
  await f.node("Metadata", "description: ../../src/core/a.ts");
  const index = await f.load();
  assert.deepEqual(names(index, ["src/core/a.ts"]), ["File", "Peer"]);
  assert.deepEqual(names(index, ["src/core/b.ts"]), ["Nearest"]);
  assert.deepEqual(names(index, ["src/other.ts"]), ["Root"]);
  assert.deepEqual(names(index, ["lib/utils/x.ts", "lib/utility.ts"]), ["Prefix"]);
  assert.deepEqual(names(index, ["library/util.ts", ".tent/Root/Root.md"]), []);
  for (const node of index.nodes) assert.equal(path.isAbsolute(node.path), true);
  assert.ok(!JSON.stringify(index).includes("secret body"));
});

test("only actual changes to a linked section beat directory coverage", async (t) => {
  const f = await fixture(t);
  await f.node("Directory", "resource: ../../docs/");
  await f.node("Section", 'resource: "../../docs/spec.md#Rules"');
  const index = await f.load();
  const targets = stopCoverageSections(index, ["docs/spec.md"]);
  assert.deepEqual([...targets.keys()], [sectionKey("docs/spec.md", "Rules")]);
  assert.equal(stopCoverageSections(index, ["elsewhere.md"]).size, 0);
  const before = "# Rules\nold\n# Other\nold\n";
  const wrong = "# Rules\nold\n# Other\nnew\n";
  const actual = "# Rules\nnew\n# Other\nold\n";
  const fingerprint = (raw: string) =>
    sectionFingerprints(raw, [{ heading: "Rules" }]).get("Rules")!.fingerprint;
  assert.equal(fingerprint(before), fingerprint(wrong));
  assert.deepEqual(names(index, ["docs/spec.md"], new Set()), ["Directory"]);
  assert.notEqual(fingerprint(before), fingerprint(actual));
  assert.deepEqual(names(index, ["docs/spec.md"], new Set(targets.keys())), ["Section"]);
});

test("the three required type names have identical coverage behavior", async (t) => {
  const f = await fixture(t);
  for (const type of ["goal", "prompt", "output"]) {
    await f.node("Same", `type: ${type}\nresource: ../../src/a.ts`);
    assert.deepEqual(names(await f.load(), ["src/a.ts"]), ["Same"]);
  }
});

test("deprecated, invalid and duplicate Nodes cannot provide coverage", async (t) => {
  const f = await fixture(t);
  await f.node("Live", "resource: ../../src/");
  await f.node("Old", "status: deprecated\nresource: ../../src/a.ts");
  await f.node("Invalid", "status: nonsense\nresource: ../../src/a.ts");
  // Replace the automatically generated id to make each document valid in isolation.
  for (const name of ["DuplicateA", "DuplicateB"]) {
    await f.node(name, "resource: ../../src/a.ts");
    const filename = path.join(f.systemRoot, name, `${name}.md`);
    await fs.writeFile(
      filename,
      (await fs.readFile(filename, "utf8")).replace(`node-${name}`, "node-duplicate"),
    );
  }
  assert.deepEqual(names(await f.load(), ["src/a.ts"]), ["Live"]);
});

test("main-checkout absolute materials cover the same relative path in a linked worktree", async (t) => {
  const f = await fixture(t);
  await f.node("Main", `resource: ${pathToFileURL(path.join(f.root, "src/a.ts")).href}`);
  const linked = path.join(f.root, ".worktrees", "linked");
  const index = await loadStopCoverage(f.systemRoot, linked, f.adapter);
  assert.deepEqual(names(index, ["src/a.ts"]), ["Main"]);
  assert.equal(index.nodes[0]!.path, path.join(f.systemRoot, "Main", "Main.md"));
});

test("warm Stop reuses unchanged exact header observations and rechecks changed files", async (t) => {
  const f = await fixture(t);
  await f.node("A", "resource: ../../src/a.ts", "BODY".repeat(40_000));
  const observed: string[] = [];
  const readFile = f.adapter.readFile.bind(f.adapter);
  t.mock.method(f.adapter, "readFile", async (filename: string) => {
    assert.notEqual(
      filename,
      "A/A.md",
      "coverage must request the header instead of the Node body",
    );
    return readFile(filename);
  });
  const read = f.adapter.readFrontmatterObservation.bind(f.adapter);
  t.mock.method(f.adapter, "readFrontmatterObservation", async (filename: string) => {
    observed.push(filename);
    return read(filename);
  });
  // Keep the conservative file-state cache's one-second age rule without a sleep.
  const now = Date.now() + 10_000;
  t.mock.method(Date, "now", () => now);
  const coldStart = performance.now();
  const cold = await f.load();
  const coldMs = performance.now() - coldStart;
  assert.deepEqual(observed, ["A/A.md"]);
  observed.length = 0;
  const warmStart = performance.now();
  assert.deepEqual(await f.load(), cold);
  const warmMs = performance.now() - warmStart;
  assert.deepEqual(observed, []);
  await f.node("A", "resource: ../../src/b.ts");
  assert.deepEqual(names(await f.load(), ["src/b.ts"]), ["A"]);
  assert.deepEqual(observed, ["A/A.md"]);
  t.diagnostic(
    `header cache: cold ${coldMs.toFixed(1)} ms / 1 read; warm ${warmMs.toFixed(1)} ms / 0 reads`,
  );
});

test("format emits the exact sections, deterministic order, no truncation or body", () => {
  assert.equal(formatStopCoverage([]), "");
  const pointers = Array.from({ length: 120 }, (_, i) => ({
    nodeId: `node-${i}`,
    name: `name-${i}-${"x".repeat(90)}`,
    path: path.resolve(`Node-${String(i).padStart(3, "0")}.md`),
    type: ["goal", "prompt", "output"][i % 3]!,
  }));
  const problems = [
    { path: path.resolve("Z.md"), problem: "broken resource" },
    { path: path.resolve("A.md"), problem: "duplicate id" },
  ];
  const text = formatStopCoverage([...pointers].reverse(), problems);
  assert.equal(
    text,
    "Files changed this turn are covered by these Tent Nodes:\n" +
      pointers.map((node) => `- ${node.name} (${node.type}): ${node.path}`).join("\n") +
      "\n\nCorrect each against what it records: a goal against what the user wants now, a prompt against the decisions made, an output against the workspace. Record anything lasting the turn settled. Leave a Node that still matches as it is, and if nothing changed say nothing about Tent: a check that changed nothing is noise to the user.\n\nThese Tent Node files have problems:\n" +
      [...problems]
        .reverse()
        .map((item) => `- ${item.path}: ${item.problem}`)
        .join("\n"),
  );
  assert.ok(text.length > 8192);
  assert.equal(text.includes("\r"), false);
  assert.equal(
    formatStopCoverage([], [problems[0]!]),
    `These Tent Node files have problems:\n- ${problems[0]!.path}: broken resource`,
  );
});
