import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import type { FsAdapter } from "../src/core/adapter.js";
import type { RepositoryMaterial } from "../src/core/repository-material.js";
import { observeNodeMaterials, syncMaterialIdentity } from "../src/core/node-sync-record.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { testScratchRoot } from "./scratch.js";

const repository = (blob: string): RepositoryMaterial => ({
  commonDir: ".git",
  path: "shared.txt",
  blob: blob.repeat(40),
});
const previous = (resource: string, owner: string, retained: RepositoryMaterial) => ({
  materials: [{ identity: syncMaterialIdentity(resource, owner), repository: retained }],
});
const observer = (): FsAdapter =>
  new NodeFs(path.join(testScratchRoot(), "observation-unit", ".tent"));

test("one inspection shares current material across different retained blobs and refreshes next time", async () => {
  const fs = observer();
  const calls: Array<RepositoryMaterial | undefined> = [];
  let current = "a".repeat(64);
  fs.observeMaterial = async (_resource, _owner, retained) => {
    calls.push(retained);
    return { observedVersion: current };
  };
  const observations = new Map();
  const first = await observeNodeMaterials(
    fs,
    { resource: "../../shared.txt" },
    "A/A.md",
    undefined,
    undefined,
    previous("../../shared.txt", "A/A.md", repository("1")),
    observations,
  );
  const second = await observeNodeMaterials(
    fs,
    { resource: "../../../shared.txt" },
    "B/C/C.md",
    undefined,
    undefined,
    previous("../../../shared.txt", "B/C/C.md", repository("2")),
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
    previous("../../shared.txt", "A/A.md", repository("1")),
    new Map(),
  );
  assert.equal(next[0]!.version, current);
  assert.equal(calls.length, 2);
});

for (const resource of ["../../shared.txt", "../../shared/"]) {
  test(`unavailable current material preserves each retained relocation: ${resource}`, async () => {
    const fs = observer();
    const calls: Array<RepositoryMaterial | undefined> = [];
    fs.observeMaterial = async (_resource, _owner, retained) => {
      calls.push(retained);
      if (!retained)
        throw Object.assign(new Error("ENOENT: current material is missing"), { code: "ENOENT" });
      return {
        observedVersion: retained.blob[0]!.repeat(64),
        readFrom: `checkout-${retained.blob[0]}`,
      };
    };
    const observations = new Map();
    const a = await observeNodeMaterials(
      fs,
      { resource },
      "A/A.md",
      undefined,
      undefined,
      previous(resource, "A/A.md", repository("1")),
      observations,
    );
    const b = await observeNodeMaterials(
      fs,
      { resource },
      "B/B.md",
      undefined,
      undefined,
      previous(resource, "B/B.md", repository("2")),
      observations,
    );
    const again = await observeNodeMaterials(
      fs,
      { resource },
      "A/A.md",
      undefined,
      undefined,
      previous(resource, "A/A.md", repository("1")),
      observations,
    );
    assert.equal(a[0]!.version, "1".repeat(64));
    assert.equal(b[0]!.version, "2".repeat(64));
    assert.match(a[0]!.reason!, /checkout-1/);
    assert.match(b[0]!.reason!, /checkout-2/);
    assert.deepEqual(again, a);
    assert.deepEqual(calls, [undefined, repository("1"), repository("2")]);
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
    undefined,
    observations,
  );
  assert.equal(result[0]!.version, "a".repeat(64));
  assert.equal(result[1]!.version, "b".repeat(64));
  assert.equal(result[2]!.version, undefined);
  assert.match(result[2]!.reason!, /heading not found/);
  assert.equal(calls.length, 3);
});
