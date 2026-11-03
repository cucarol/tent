import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { checkModuleMap } from "../src/core/check/module-map.js";
import { repositoryFacts } from "../src/core/base/repository-facts.js";
import { readRepositorySources } from "../src/fs/repository-sources.js";
import { testScratchRoot } from "./scratch.js";
import { removeTestFixture } from "./node-fs.js";
import { novelProjectFiles, videoProjectFiles } from "./fixtures/project-parts.js";
import { draftWorkspaceModules } from "../src/core/check/workspace-draft.js";
import type { ModuleMapCommit } from "../src/core/check/module-map.js";

function draft(files: Record<string, string | Uint8Array>, commits: ModuleMapCommit[] = []) {
  const facts = repositoryFacts(
    Object.entries(files).map(([path, content]) => ({
      path,
      ...(typeof content === "string" ? {} : { binary: true }),
    })),
  );
  const trackedFiles = Object.keys(files);
  const result = draftWorkspaceModules(
    {
      head: null,
      coverage: {
        trackedFiles: trackedFiles.length,
        coveredFiles: 0,
        uncoveredFiles: trackedFiles,
        directories: [],
      },
      inspectionErrors: [],
      ...facts,
    },
    commits,
  );
  return {
    ...result,
    facts,
    checked: checkModuleMap({
      trackedFiles,
      nodes: result.nodes,
      textFiles: facts.textFiles,
      imports: [],
      commits: [],
    }),
  };
}

const part = (directory: string) => ({
  id: directory,
  path: directory,
  name: directory,
  body: "",
  materials: [{ path: directory, kind: "directory" as const }],
});

test("novel draft keeps thirty numbered chapters whole and gives a draft-only split prompt", () => {
  const result = draft(novelProjectFiles());
  assert.deepEqual(
    result.checked.partFacts.map(({ path, textFiles }) => ({ path, textFiles })),
    [
      { path: "Root files", textFiles: 1 },
      { path: "chapters", textFiles: 30 },
      { path: "notes", textFiles: 2 },
    ],
  );
  assert.deepEqual(result.warnings, [
    "Large part with no split Tent can see: chapters (30 files). Split it into the units this project uses, such as chapters or episodes, or keep it whole.",
  ]);
  assert.deepEqual(result.checked.issues, []);
});

test("video draft retains the asset hierarchy and counts only readable script text", () => {
  const result = draft(videoProjectFiles());
  assert.deepEqual(
    result.checked.partFacts.map(({ path, textFiles }) => ({ path, textFiles })),
    [
      { path: "Root files", textFiles: 1 },
      { path: "assets", textFiles: 0 },
      { path: "assets/audio", textFiles: 0 },
      { path: "assets/fonts", textFiles: 0 },
      { path: "assets/footage", textFiles: 0 },
      { path: "assets/images", textFiles: 0 },
      { path: "scripts", textFiles: 2 },
    ],
  );
  const assets = result.nodes.find((node) => node.path === "assets")!;
  assert.deepEqual(
    result.nodes.filter((node) => node.parentId === assets.id).map((node) => node.name),
    ["audio", "fonts", "footage", "images"],
  );
  assert.equal(result.checked.partFacts.flatMap((part) => part.files).length, 8);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.checked.issues, []);
});

test("text test fixtures stay covered without contributing to the reading size", () => {
  const result = draft({ "README.md": "Project", "tests/expected.txt": "Expected result" });
  assert.deepEqual(result.checked.issues, []);
  assert.deepEqual(
    result.checked.partFacts.map(({ path, textFiles }) => ({ path, textFiles })),
    [
      { path: "Root files", textFiles: 1 },
      { path: "Tests", textFiles: 0 },
    ],
  );
});

test("root text uses the same prefix evidence and keeps only scattered files in Root files", () => {
  const files = {
    "README.md": "Project",
    ...Object.fromEntries(
      ["chapter", "notes"].flatMap((prefix) =>
        Array.from({ length: 6 }, (_, i) => [`${prefix}-${i}.md`, "Text"]),
      ),
    ),
  };
  const result = draft(files);
  assert.deepEqual(
    result.checked.partFacts.map(({ path, textFiles }) => ({ path, textFiles })),
    [
      { path: "Root files", textFiles: 1 },
      { path: "chapter", textFiles: 6 },
      { path: "notes", textFiles: 6 },
    ],
  );
  assert.deepEqual(result.warnings, []);
});

test("generated sources do not force a small readable part into draft size groups", () => {
  const result = draft({
    "lib/source.ts": "export const value = 1;",
    ...Object.fromEntries(
      Array.from({ length: 24 }, (_, i) => [`lib/generated-${i}.pb.ts`, "Generated code"]),
    ),
  });
  assert.equal(result.nodes.length, 1);
  assert.equal(result.checked.partFacts[0]!.textFiles, 1);
  assert.equal(result.checked.partFacts[0]!.files.length, 25);
  assert.deepEqual(result.warnings, []);
});

test("text prefixes and repeated shared changes separate evidenced units without numbered size chunks", () => {
  const prefixes = Object.fromEntries(
    ["characters", "places"].flatMap((prefix) =>
      Array.from({ length: 12 }, (_, i) => [`research/${prefix}-${i}.md`, "Notes"]),
    ),
  );
  const grouped = draft(prefixes);
  assert.deepEqual(
    grouped.checked.partFacts.filter((part) => part.textFiles).map((part) => part.textFiles),
    [12, 12],
  );
  assert.equal(grouped.warnings.length, 2);
  const files = Array.from({ length: 12 }, (_, i) => `notes/page${i}.md`);
  const flat = Object.fromEntries(files.map((file) => [file, "Notes"]));
  const commits = Array.from({ length: 20 }, (_, i) => ({
    commit: String(i),
    files: i < 5 ? files.slice(0, 6) : i < 10 ? files.slice(6) : ["other.txt"],
    changedFiles: i < 10 ? 6 : 1,
  }));
  const history = draft(flat, commits);
  assert.deepEqual(
    draft(flat).checked.partFacts.map((part) => part.textFiles),
    [12],
  );
  assert.deepEqual(
    history.checked.partFacts.filter((part) => part.textFiles).map((part) => part.textFiles),
    [6, 6],
  );
  assert.deepEqual(history.warnings, []);
  const chapters = Object.fromEntries(
    files.map((file, i) => [`notes/chapter-${i}.md`, flat[file]!]),
  );
  const chapterCommits = commits.map((commit) => ({
    ...commit,
    files: commit.files.map((file) =>
      files.includes(file) ? `notes/chapter-${files.indexOf(file)}.md` : file,
    ),
  }));
  assert.deepEqual(
    draft(chapters, chapterCommits)
      .checked.partFacts.filter((part) => part.textFiles)
      .map((part) => part.textFiles),
    [6, 6],
  );
  assert.deepEqual(
    draft(Object.fromEntries(Object.entries(flat).reverse()), [...commits].reverse()).batch,
    history.batch,
  );
});

test("existing text maps report evidenced size groups, and leave an unsplittable novel whole", () => {
  const files = Object.keys(novelProjectFiles());
  const result = checkModuleMap({
    trackedFiles: files,
    nodes: [
      part("chapters"),
      part("notes"),
      { ...part("Root files"), materials: [{ path: "README.md", kind: "file" }] },
    ],
    imports: [],
    commits: [],
  });
  assert.deepEqual(result.issues, []);
  assert.equal(result.partFacts.find((item) => item.id === "chapters")!.textFiles, 30);
  const grouped = ["characters", "places"].flatMap((prefix) =>
    Array.from({ length: 12 }, (_, i) => `research/${prefix}-${i}.md`),
  );
  const evidence = checkModuleMap({
    trackedFiles: grouped,
    nodes: [part("research")],
    imports: [],
    commits: [],
  });
  assert.deepEqual(
    evidence.issues.map((issue) => issue.code),
    ["part.oversized"],
  );
  assert.equal(evidence.issues[0]!.facts.textFiles, 24);
  assert.deepEqual(evidence.issues[0]!.facts.groups, [
    { path: "research/characters-", files: 12 },
    { path: "research/places-", files: 12 },
  ]);
});

test("text sizes exclude tests, generated files and binary assets, including unknown binary formats", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "scan-text-kinds-"));
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  const files = {
    ...videoProjectFiles(),
    "scripts/generated/transcript.txt": "Generated transcript",
    "scripts/testdata/sample.txt": "Test fixture",
    "scripts/notes.custom": "Readable prose with an unknown extension",
  };
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  }
  const sources = await readRepositorySources(root, Object.keys(files), { classifyText: true });
  assert.deepEqual(sources.errors, []);
  assert.ok(sources.files.every((source) => source.content === undefined));
  const facts = repositoryFacts(sources.files);
  assert.deepEqual(facts.textFiles, [
    "README.md",
    "scripts/episode-one.md",
    "scripts/episode-two.md",
    "scripts/notes.custom",
  ]);
  const checked = checkModuleMap({
    trackedFiles: Object.keys(files),
    textFiles: facts.textFiles,
    nodes: [part("assets"), part("scripts")],
    imports: [],
    commits: [],
  });
  assert.equal(checked.partFacts.find((item) => item.id === "assets")!.textFiles, 0);
  assert.equal(checked.partFacts.find((item) => item.id === "scripts")!.textFiles, 3);
});
