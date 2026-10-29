import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { repositoryFacts } from "../src/core/base/repository-facts.js";
import {
  formatWorkspaceDraft,
  workspaceDraftReportPath,
  workspaceDraftExitCode,
  type WorkspaceDraftSummary,
} from "../src/core/check/workspace-draft.js";
import { writeWorkspaceDraft } from "../src/fs/workspace-scan.js";
import { removeTestFixture } from "./node-fs.js";
import { testScratchRoot } from "./scratch.js";
import { readWorkspaceDraftReport } from "./workspace-draft-report.js";
import { serializeWorkspaceDraftReport } from "../src/core/check/workspace-draft-report.js";

function denseSummary(): WorkspaceDraftSummary {
  const testedBy = Array.from({ length: 250 }, (_, i) => `tests/中文-${i}.test.ts`);
  const modules = Array.from({ length: 120 }, (_, i) => ({
    ref: `m${i}`,
    path: `src/模块-${i}`,
    name: `模块-${i}`,
    files: [`src/模块-${i}/main.ts`],
    productionFiles: 8,
    ...(i ? { parent: "m0" } : {}),
    testedBy,
    coChanges: Array.from({ length: 80 }, (_, j) => ({
      moduleId: `m${j}`,
      sharedCommits: 50,
      moduleCommits: 50,
      ratio: 1,
    })),
  }));
  const history = Array.from({ length: 200 }, (_, i) => ({
    commit: String(i).padStart(40, "0"),
    files: [`src/模块-${i % 120}/main.ts`],
    changedFiles: 1,
  }));
  return {
    modules,
    guidanceFiles: Array.from({ length: 30 }, (_, i) => `src/模块-${i}/AGENTS.md`),
    warnings: Array.from({ length: 25 }, (_, i) => `Boundary ${i} needs review`),
    issues: Array.from({ length: 90 }, (_, i) => ({
      code: i % 2 ? "deps.cycle" : "history.always-together",
      object: `m${i}`,
      facts: { nodeIds: modules.map((module) => module.ref), testedBy },
      fix: "Review the listed boundaries and record the intended relationship.",
    })),
    inspectionErrors: Array.from({ length: 25 }, (_, i) => ({
      node: `src/模块-${i}`,
      reason: "Cannot read source",
    })),
    importIssues: Array.from({ length: 40 }, (_, i) => ({
      file: `src/模块-${i}/main.ts`,
      specifier: "@alias/missing",
      reason: "No unique import target",
    })),
    unassignedImports: Array.from({ length: 20 }, (_, i) => ({
      from: `src/模块-${i}/main.go`,
      to: "shared",
      reason: "No unique module owner",
    })),
    trackedFiles: 960,
    historyCommits: history.length,
    history,
    head: history[0].commit,
    imports: {
      ...repositoryFacts([]).imports,
      edges: [
        {
          from: "src/a.ts",
          to: "src/b.ts",
          specifier: "./b",
          kind: "file",
          execution: "module-load",
        },
      ],
    },
    testImports: { edges: [], issues: [], scannedFiles: 0 },
  };
}

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "draft-receipt-"));
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".tent"));
  return root;
}

test("dense evidence receipts count every item and locate all omitted evidence within 4096 bytes", () => {
  const summary = denseSummary();
  const before = JSON.stringify(summary);
  const locations = {
    workspaceRoot: "C:/workspace",
    draft: "C:/workspace/batch.json",
    report: "C:/workspace/batch.report.json",
  };
  for (const json of [false, true]) {
    const stdout = formatWorkspaceDraft(summary, locations, json);
    assert.ok(Buffer.byteLength(stdout) <= 4096, `receipt was ${Buffer.byteLength(stdout)} bytes`);
    assert.ok(stdout.endsWith("\n"));
    assert.equal(formatWorkspaceDraft(summary, locations, json), stdout);
    assert.match(stdout, /batch\.report\.json/);
  }
  const receipt = JSON.parse(formatWorkspaceDraft(summary, locations, true));
  assert.equal(receipt.counts.modules, 120);
  assert.equal(receipt.counts.historyCommits, 200);
  assert.equal(receipt.counts.testedBy, 30000);
  assert.equal(receipt.counts.coChanges, 9600);
  assert.deepEqual(receipt.counts.issuesByCode, {
    "history.always-together": 45,
    "deps.cycle": 45,
  });
  assert.equal(receipt.counts.inspectionErrors, 25);
  assert.equal(receipt.counts.importIssues, 40);
  assert.equal(receipt.counts.unassignedImports, 20);
  assert.ok(receipt.examples.guidanceFiles.length > 0);
  for (const key of [
    "guidanceFiles",
    "issues",
    "inspectionErrors",
    "unassignedImports",
    "warnings",
    "importIssues",
    "modules",
  ] as const) {
    assert.equal(
      receipt.omitted[key].count + (receipt.examples[key]?.length ?? 0),
      summary[key].length,
    );
    assert.equal(
      receipt.omitted[key].at,
      key === "guidanceFiles" || key === "warnings"
        ? `snapshot header: ${key}`
        : key === "modules"
          ? 'ref lines (search "ref":"@<ref>"): module'
          : `ref/finding lines: ${key}`,
    );
  }
  assert.deepEqual(receipt.omitted.testedBy, { count: 30000, at: "ref lines: module.testedBy" });
  assert.deepEqual(receipt.omitted.coChanges, { count: 9600, at: "ref lines: module.coChanges" });
  assert.deepEqual(receipt.omitted.history, { count: 200, at: "ref/history lines: history" });
  assert.equal(JSON.stringify(summary), before, "receipt cannot trim the authoritative evidence");
});

test("long UTF-8 and escaped paths remain bounded with an actionable sibling report locator", () => {
  const summary = denseSummary();
  const draft = path.resolve("C:/workspace", '中文😀\"\n\\'.repeat(1800) + "batch.json");
  const report = workspaceDraftReportPath(draft);
  for (const json of [false, true]) {
    const stdout = formatWorkspaceDraft(
      summary,
      { workspaceRoot: "C:/workspace", draft, report },
      json,
    );
    assert.ok(Buffer.byteLength(stdout, "utf8") <= 4096);
    assert.match(stdout, /Next to the --draft file/);
    assert.match(stdout, /replace its \.json suffix with \.report\.json/);
    assert.match(stdout, /batch\.report\.json/);
    if (json) {
      const receipt = JSON.parse(stdout);
      assert.deepEqual(receipt.omitted.reportPath, { count: 1, at: "snapshot header: report" });
      assert.ok(!receipt.report.includes("\ufffd"));
    }
  }
  assert.equal(workspaceDraftReportPath("batch.JSON"), "batch.report.json");
  assert.equal(workspaceDraftReportPath("batch"), "batch.report.json");
});

test("omitting each blocking diagnostic category cannot turn its exit status clean; parser issues stay advisory", () => {
  const base = denseSummary();
  for (const category of ["issues", "inspectionErrors", "unassignedImports"] as const) {
    const summary = {
      ...base,
      issues: [],
      inspectionErrors: [],
      unassignedImports: [],
      [category]: base[category],
    } as WorkspaceDraftSummary;
    const stdout = formatWorkspaceDraft(
      summary,
      {
        workspaceRoot: "C:/workspace",
        draft: "C:/workspace/batch.json",
        report: "C:/workspace/batch.report.json",
      },
      true,
    );
    assert.ok(Buffer.byteLength(stdout) <= 4096);
    assert.ok(JSON.parse(stdout).omitted[category].count > 0);
    assert.equal(workspaceDraftExitCode(summary), 1);
  }
  assert.equal(
    workspaceDraftExitCode({ ...base, issues: [], inspectionErrors: [], unassignedImports: [] }),
    0,
  );
});

test("publication preserves the exact editable batch and all dense report evidence", async (t) => {
  const root = await fixture(t);
  const summary = denseSummary();
  const batch = { items: [{ op: "create", ref: "m1", body: "" }] };
  const files = await writeWorkspaceDraft(root, "batch.json", batch, summary);
  assert.equal(await fs.readFile(files.draft, "utf8"), JSON.stringify(batch, null, 2) + "\n");
  const raw = await fs.readFile(files.report, "utf8");
  const evidence = readWorkspaceDraftReport(raw);
  const { draft, report, snapshot, counts, ...header } = JSON.parse(raw.split("\n")[0]!);
  assert.deepEqual(evidence, summary);
  assert.equal(draft, files.draft);
  assert.equal(report, files.report);
  assert.equal(snapshot, true);
  assert.equal(counts.modules, summary.modules.length);
  assert.equal(header.modules, undefined);
  assert.equal(header.history, undefined);
  assert.deepEqual(header.imports, { scannedFiles: summary.imports.scannedFiles });
  assert.ok((await fs.stat(files.report)).size > 1000000);
});

test("one exact ref search yields its complete module evidence; all original arrays can be reconstructed", () => {
  const base = denseSummary();
  const modules = base.modules.slice(0, 2).map((module, i) => ({
    ...module,
    ref: i ? "other" : "core",
    path: `Renamed suggested Node ${i}`,
    files: [`code/${i}/main.ts`, `code/${i}/part.go`],
  }));
  const sharedIssue = {
    ...base.issues[0]!,
    object: "Renamed suggested Node 0 + Renamed suggested Node 1",
    facts: { nodeIds: ["core", "other"] },
  };
  const orphanIssue = {
    ...base.issues[0]!,
    object: "unowned",
    facts: { files: ["deleted/old.ts"] },
  };
  const edge = {
    ...base.imports.edges[0]!,
    from: modules[0]!.files[0]!,
    to: modules[1]!.files[0]!,
  };
  const orphanEdge = { ...edge, from: "old/from.ts", to: "old/to.ts" };
  const packageEdge = { ...edge, to: "code/1", kind: "directory" as const };
  const summary: WorkspaceDraftSummary = {
    ...base,
    modules,
    history: [
      { ...base.history[0]!, files: modules.map((module) => module.files[0]!) },
      { ...base.history[0]!, files: ["deleted/old.ts"] },
      { ...base.history[0]!, files: modules.map((module) => module.files[0]!) },
    ],
    issues: [sharedIssue, orphanIssue],
    inspectionErrors: [
      { node: modules[0]!.files[0]!, reason: "owned" },
      { node: "missing", reason: "unowned" },
    ],
    importIssues: [
      { file: modules[0]!.files[0]!, reason: "owned" },
      { file: "missing", reason: "unowned" },
    ],
    unassignedImports: [
      { from: modules[0]!.files[0]!, to: "code/1", reason: "shared package" },
      { from: "missing", to: "old", reason: "unowned" },
    ],
    imports: {
      ...base.imports,
      edges: [edge, orphanEdge, edge, packageEdge],
      issues: [{ file: "missing", reason: "unowned import" }],
    },
    testImports: {
      edges: [{ ...edge, from: "tests/core.test.ts", to: modules[0]!.files[0]! }, orphanEdge],
      issues: [{ file: modules[0]!.files[0]!, reason: "owned test import" }],
      scannedFiles: 2,
    },
  };
  const before = JSON.stringify(summary);
  const raw = serializeWorkspaceDraftReport(summary, {
    draft: "/batch.json",
    report: "/batch.report.json",
  });
  const matches = raw
    .trimEnd()
    .split("\n")
    .filter((line) => line.includes('"ref":"@core"'));
  assert.equal(matches.length, 1);
  assert.ok(matches[0]!.startsWith('{"ref":"@core",'));
  const row = JSON.parse(matches[0]!);
  assert.deepEqual(row.module, modules[0]);
  assert.deepEqual(row.module.testedBy, modules[0]!.testedBy);
  assert.deepEqual(row.module.coChanges, modules[0]!.coChanges);
  assert.deepEqual(
    row.history.map((entry: { index: number }) => entry.index),
    [0, 2],
  );
  assert.deepEqual(
    row.imports.edges.map((entry: { index: number }) => entry.index),
    [0, 2, 3],
  );
  assert.equal(row.testImports.edges.length, 1);
  assert.equal(row.testImports.issues.length, 1);
  assert.deepEqual(row.issues, [{ index: 0, value: sharedIssue }]);
  assert.equal(row.inspectionErrors.length, 1);
  assert.equal(row.importIssues.length, 1);
  assert.equal(row.unassignedImports.length, 1);
  const rows = raw
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  const other = rows.find((candidate) => candidate.ref === "@other");
  assert.deepEqual(other.issues, row.issues);
  assert.deepEqual(other.history, row.history);
  assert.equal(rows.filter((candidate) => candidate.finding === "issues").length, 1);
  assert.deepEqual(rows.find((candidate) => candidate.finding === "issues").value, orphanIssue);
  assert.equal(rows.filter((candidate) => candidate.history === true).length, 1);
  assert.equal(rows.filter((candidate) => candidate.imports === "edges").length, 1);
  assert.deepEqual(readWorkspaceDraftReport(raw), summary);
  assert.equal(JSON.stringify(summary), before);
});

test("either existing artifact prevents publication without replacing it or leaving a new companion", async (t) => {
  const root = await fixture(t);
  for (const existing of ["draft", "report"]) {
    const draft = path.join(root, `${existing}.json`);
    const report = workspaceDraftReportPath(draft);
    const preserved = existing === "draft" ? draft : report;
    const absent = existing === "draft" ? report : draft;
    await fs.writeFile(preserved, "keep my work\n");
    await assert.rejects(writeWorkspaceDraft(root, draft, { items: [] }, denseSummary()), {
      code: "EEXIST",
    });
    assert.equal(await fs.readFile(preserved, "utf8"), "keep my work\n");
    await assert.rejects(fs.stat(absent), { code: "ENOENT" });
  }
});

test("ordinary failure after creating and partially writing the second artifact removes only new files", async (t) => {
  const root = await fixture(t);
  const draft = path.join(root, "batch.json"),
    report = workspaceDraftReportPath(draft);
  await fs.writeFile(path.join(root, "other.json"), "unrelated");
  const originalOpen = fs.open;
  const mocked = t.mock.method(fs, "open", async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (args[0] === report) {
      const originalWrite = handle.writeFile.bind(handle);
      t.mock.method(handle, "writeFile", async () => {
        await originalWrite("partial report bytes");
        throw Object.assign(new Error("injected second artifact write failure"), { code: "EIO" });
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      writeWorkspaceDraft(root, draft, { items: [] }, denseSummary()),
      /injected second artifact write failure/,
    );
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  await assert.rejects(fs.stat(draft), { code: "ENOENT" });
  await assert.rejects(fs.stat(report), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(root, "other.json"), "utf8"), "unrelated");
});
