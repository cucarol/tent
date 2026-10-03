import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { testScratchRoot } from "./scratch.js";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  INTEGRATION_TEST_FILES,
  discoverTestFiles,
  sanitizeTestEnv,
  selectTestFiles,
} from "../scripts/run-tests.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runnerPath = path.join(repoRoot, "scripts", "run-tests.ts");

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(testScratchRoot(), "tent-test-runner-"));
  for (const file of [
    "test/a.test.ts",
    "test/nested/b.test.ts",
    "test/fixtures/ignored.test.ts",
    "test/not-live.e2e.ts",
  ]) {
    const absolute = path.join(root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, "", "utf8");
  }
  return root;
}

test("discovers current tests without fixtures, live e2e,", () => {
  const root = fixtureRoot();
  try {
    assert.deepEqual(discoverTestFiles(root), ["test/a.test.ts", "test/nested/b.test.ts"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("full, fast, and integration form one complete non-overlapping partition", () => {
  const all = ["test/a.test.ts", "test/b.test.ts", "test/slow.test.ts"];
  const integration = ["test/slow.test.ts"];
  assert.deepEqual(selectTestFiles(all, "full", integration), all);
  assert.deepEqual(selectTestFiles(all, "fast", integration), all.slice(0, 2));
  assert.deepEqual(selectTestFiles(all, "integration", integration), integration);
  assert.throws(
    () => selectTestFiles(all, "full", ["test/missing.test.ts"]),
    /integration test is missing/,
  );
  assert.throws(() => selectTestFiles(all, "turbo", integration), /unknown test mode/);
});

test("repository discovery includes formerly omitted tests and every integration entry", () => {
  const files = discoverTestFiles(repoRoot);
  for (const file of [
    "test/node-status.test.ts",
    "test/card-document.test.ts",
    ...INTEGRATION_TEST_FILES,
  ]) {
    assert.ok(files.includes(file), `missing discovered test: ${file}`);
  }
  const fast = selectTestFiles(files, "fast");
  const integration = selectTestFiles(files, "integration");
  assert.ok(fast.length > 0);
  assert.ok(integration.length > 0);
  assert.deepEqual(
    fast.filter((file) => integration.includes(file)),
    [],
  );
  assert.deepEqual([...fast, ...integration].sort(), files);
});

test("CLI list matches discovery and rejects unknown input", () => {
  const listed = spawnSync(process.execPath, ["--import", "tsx", runnerPath, "full", "--list"], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.stdout.trim().split(/\r?\n/), discoverTestFiles(repoRoot));

  const invalid = spawnSync(process.execPath, ["--import", "tsx", runnerPath, "wat"], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /unknown test mode/);
});

test("test child environment does not emit conflicting color warnings", () => {
  const clean = sanitizeTestEnv({ FORCE_COLOR: "1", NO_COLOR: "1", KEEP: "yes" });
  assert.equal(clean.FORCE_COLOR, undefined);
  assert.equal(clean.NO_COLOR, "1");
  assert.equal(clean.KEEP, "yes");
});
