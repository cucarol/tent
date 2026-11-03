import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
const { removeSourceTrack, convertWorkspace } = await import(
  new URL("../scripts/one-off/remove-source-track.mjs", import.meta.url).href
);

const scratch = fileURLToPath(new URL("../.scratch/converge-stop1103/fields/", import.meta.url));

test("offline source conversion removes Node verified and source track while preserving other values", () => {
  for (const header of [
    "sources:\n  - resource: ../../src/\n    track: structure # retired\n    verified: false\n",
    "sources:\n  - track: structure\n    resource: ../../src/\n    verified: false\n",
    "sources: [{resource: ../../src/, track: structure, verified: false}]\n",
    "sources: [{track: structure, resource: ../../src/, verified: false}]\n",
    "sources: [{resource: ../../src/, verified: false, track: structure}]\n",
  ]) {
    const raw =
      "\uFEFF---\r\n" +
      ("id: node-test\ntype: prompt\nverified: yes\ntrack: custom\n" + header).replaceAll(
        "\n",
        "\r\n",
      ) +
      "---\r\nBody: track: structure\r\n";
    const next = removeSourceTrack(raw);
    assert.ok(next.startsWith("\uFEFF---\r\nid: node-test\r\ntype: prompt\r\ntrack: custom\r\n"));
    assert.ok(next.endsWith("---\r\nBody: track: structure\r\n"));
    assert.ok(next.includes("verified: false"));
    assert.equal(next.includes("track: structure # retired"), false);
    assert.equal(removeSourceTrack(next), next);
  }
});

test("offline conversion previews then updates only Node files in a scratch workspace", async (t) => {
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "track-copy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const raw =
    "---\nid: node-a\ntype: goal\nsources: [{resource: ../../src/, track: structure}]\nverified: false\n---\nBody\n";
  for (const name of ["A/A.md", "roles/Rule/Rule.md", "cards/card-a.md", ".git/history.md"]) {
    const filename = path.join(root, ".tent", name);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, raw);
  }
  assert.deepEqual(await convertWorkspace(root), ["A/A.md"]);
  assert.equal(await fs.readFile(path.join(root, ".tent/A/A.md"), "utf8"), raw);
  assert.deepEqual(await convertWorkspace(root, true), ["A/A.md"]);
  assert.equal(await fs.readFile(path.join(root, ".tent/A/A.md"), "utf8"), removeSourceTrack(raw));
  for (const name of ["roles/Rule/Rule.md", "cards/card-a.md", ".git/history.md"])
    assert.equal(await fs.readFile(path.join(root, ".tent", name), "utf8"), raw);
  assert.deepEqual(await convertWorkspace(root, true), []);
});

test("aliased sources detach track without changing the shared metadata map", () => {
  const raw =
    "---\nid: node-alias\ntype: prompt\nmetadata: &shared {resource: ../../src/, track: structure, verified: false}\nsources: [*shared]\n---\nBody\n";
  const next = removeSourceTrack(raw);
  assert.ok(
    next.includes("metadata: &shared {resource: ../../src/, track: structure, verified: false}"),
  );
  assert.ok(next.includes("sources: [{ resource: ../../src/, verified: false }]"));
  assert.equal(removeSourceTrack(next), next);
});

test("verified is removed without requiring sources, for block and flow frontmatter", () => {
  for (const yaml of [
    "verified: {old: true}\nid: node-one\ntype: prompt\n",
    "id: node-one\nverified: false\ntype: prompt\n",
    "id: node-one\ntype: prompt\nverified: true\n",
    "{id: node-one, verified: true, type: prompt}\n",
  ]) {
    const raw = "---\n" + yaml + "---\nBody with verified: true\n";
    const next = removeSourceTrack(raw);
    assert.equal(next.slice(0, next.indexOf("---\nBody", 4)).includes("verified:"), false);
    assert.ok(next.endsWith("---\nBody with verified: true\n"));
    assert.equal(removeSourceTrack(next), next);
  }
});
