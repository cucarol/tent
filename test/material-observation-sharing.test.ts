import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import type { FsAdapter } from "../src/core/adapter.js";
import { observeNodeMaterials } from "../src/core/node-sync-record.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { testScratchRoot } from "./scratch.js";

const observer = (): FsAdapter =>
  new NodeFs(path.join(testScratchRoot(), "observation-unit", ".tent"));

test("one inspection shares current material across equivalent declarations and refreshes next time", async () => {
  const fs = observer();
  const calls: Array<"structure" | undefined> = [];
  let current = "a".repeat(64);
  fs.observeMaterial = async (_resource, _owner, track) => {
    calls.push(track);
    return { observedVersion: current };
  };
  const observations = new Map();
  const first = await observeNodeMaterials(
    fs,
    { resource: "../../shared.txt" },
    "A/A.md",
    undefined,
    undefined,
    observations,
  );
  const second = await observeNodeMaterials(
    fs,
    { resource: "../../../shared.txt" },
    "B/C/C.md",
    undefined,
    undefined,
    observations,
  );
  assert.equal(first[0]!.version, current);
  assert.equal(second[0]!.version, current);
  assert.deepEqual(calls, [undefined]);
  current = "b".repeat(64);
  const next = await observeNodeMaterials(
    fs,
    { resource: "../../shared.txt" },
    "A/A.md",
    undefined,
    undefined,
    new Map(),
  );
  assert.equal(next[0]!.version, current);
  assert.equal(calls.length, 2);
});

for (const resource of ["../../shared.txt", "../../shared/"]) {
  test(`unavailable current material is shared and remains unavailable: ${resource}`, async () => {
    const fs = observer();
    const calls: Array<"structure" | undefined> = [];
    fs.observeMaterial = async (_resource, _owner, track) => {
      calls.push(track);
      throw Object.assign(new Error("ENOENT: current material is missing"), { code: "ENOENT" });
    };
    const observations = new Map();
    const a = await observeNodeMaterials(
      fs,
      { resource },
      "A/A.md",
      undefined,
      undefined,
      observations,
    );
    const b = await observeNodeMaterials(
      fs,
      { resource },
      "B/B.md",
      undefined,
      undefined,
      observations,
    );
    const again = await observeNodeMaterials(
      fs,
      { resource },
      "A/A.md",
      undefined,
      undefined,
      observations,
    );
    assert.equal(a[0]!.version, undefined);
    assert.equal(b[0]!.version, undefined);
    assert.match(a[0]!.reason!, /current material is missing/);
    assert.match(b[0]!.reason!, /current material is missing/);
    assert.deepEqual(again, a);
    assert.deepEqual(calls, [undefined]);
  });
}

test("shared observations keep different sections and unavailable sources distinct", async () => {
  const fs = observer();
  const calls: string[] = [];
  fs.observeMaterial = async (resource) => {
    calls.push(resource);
    if (resource.endsWith("#Missing")) throw new Error("Markdown material heading not found");
    return { observedVersion: (resource.endsWith("#A") ? "a" : "b").repeat(64) };
  };
  const observations = new Map();
  const result = await observeNodeMaterials(
    fs,
    {
      sources: ["A", "B", "Missing"].map((heading) => ({ resource: `../../shared.md#${heading}` })),
    },
    "A/A.md",
    undefined,
    undefined,
    observations,
  );
  assert.equal(result[0]!.version, "a".repeat(64));
  assert.equal(result[1]!.version, "b".repeat(64));
  assert.equal(result[2]!.version, undefined);
  assert.match(result[2]!.reason!, /heading not found/);
  assert.equal(calls.length, 3);
});
