import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { createNode } from "../src/core/ops.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { materialLocator, validateMaterialAddresses } from "../src/core/material.js";
import { NodeWriteError, writeNodeDocument } from "../src/core/node-document-write.js";
import { readNodeForEdit } from "../src/core/node-query.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { testScratchRoot } from "./scratch.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "node-material-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await scaffoldInWorkspace(new NodeFs(root), { name: "Materials" });
  const adapter = new NodeFs(path.join(root, ".tent"));
  const env = { fs: adapter, clock: { now: () => "fixture" }, tentName: "Materials" };
  await createNode(env, { parentPath: "", name: "A", type: "goal" });
  const id = await createNode(env, { parentPath: "A", name: "B", type: "prompt", body: "base" });
  return { root, adapter, env, id, note: "A/B/B.md" };
}

test("Node create validates every material address before publishing, with its declaring path", async (t) => {
  const { adapter, env } = await fixture(t);
  for (const fields of [
    { resource: "/../spec/x.md" },
    { sources: [{ resource: "interviews" }, { resource: "/../spec/x.md" }] },
  ]) {
    await assert.rejects(
      createNode(env, { parentPath: "A", name: "Rejected", type: "output", ...fields }),
      (error: Error) => {
        assert.match(error.message, /Invalid (resource|sources\[1\]\.resource):/);
        assert.match(error.message, /escapes \.tent; use "\.\.\/\.\.\/\.\.\/spec\/x.md"/);
        return true;
      },
    );
    assert.equal(await adapter.exists("A/Rejected"), false);
  }
  const fields = {
    resource: "main material description",
    sources: [
      { resource: "note: reference" },
      { resource: "75% of interviews" },
      { resource: "../../../spec/missing%20file.md#part?raw=1" },
      { resource: "/missing/file.md?raw=1#part" },
      { resource: "urn:example:1" },
      { resource: "https://example.invalid/missing#part" },
      { resource: "file:///outside/missing.md" },
    ],
  };
  await createNode(env, { parentPath: "A", name: "Accepted", type: "output", ...fields });
  const saved = parseFrontmatter(await adapter.readFile("A/Accepted/Accepted.md"));
  assert.equal(saved.data.resource, fields.resource);
  assert.deepEqual(saved.data.sources, fields.sources);
});

test("Node frontmatter and raw writes reject new invalid resource and source addresses atomically", async (t) => {
  const { adapter, id, note } = await fixture(t);
  const live = await readNodeForEdit(adapter, id);
  for (const field of ["resource", "sources"] as const) {
    for (const invalid of ["/../spec/x.md", "./bad%zz", "./bad\\name", "https://["]) {
      const fields =
        field === "resource" ? { resource: invalid } : { sources: [{ resource: invalid }] };
      for (const input of [
        { frontmatter: fields },
        { raw: serializeFrontmatter({ ...live.frontmatter, ...fields }, "replacement") },
      ]) {
        await assert.rejects(
          writeNodeDocument(adapter, id, { baseEtag: live.etag, ...input }),
          (error: NodeWriteError) => {
            assert.ok(error instanceof NodeWriteError);
            assert.equal(error.code, "INVALID_EDIT");
            assert.match(
              error.message,
              field === "resource" ? /Invalid resource:/ : /Invalid sources\[0\]\.resource:/,
            );
            if (invalid.startsWith("/../"))
              assert.match(error.message, /\.\.\/\.\.\/\.\.\/spec\/x.md/);
            return true;
          },
        );
        assert.equal(await adapter.readFile(note), live.raw);
      }
    }
  }
  const fields = {
    resource: "../../../spec/x.md",
    sources: [{ resource: "ordinary description" }, { resource: "./missing%23name.md#part" }],
  };
  await writeNodeDocument(adapter, id, { baseEtag: live.etag, frontmatter: fields });
  assert.deepEqual(parseFrontmatter(await adapter.readFile(note)).data.sources, fields.sources);
});

test("legacy addresses survive body/raw/metadata edits, source reorder and removal but not additions", async (t) => {
  const { adapter, id, note } = await fixture(t);
  const invalid = "/../spec/x.md";
  const legacy = {
    id,
    type: "prompt",
    resource: invalid,
    sources: [
      { resource: invalid, title: "first" },
      { resource: "./bad%zz", title: "second" },
      { resource: invalid, title: "third" },
    ],
  };
  await adapter.writeFile(note, serializeFrontmatter(legacy, "legacy"));
  const edit = async (input: Parameters<typeof writeNodeDocument>[2]) => {
    const live = await readNodeForEdit(adapter, id);
    return writeNodeDocument(adapter, id, { baseEtag: live.etag, ...input });
  };
  await edit({ body: "body update" });
  await edit({ frontmatter: { description: "metadata update" } });
  const current = await readNodeForEdit(adapter, id);
  await edit({ raw: serializeFrontmatter(current.frontmatter, "raw body update") });
  const reordered = [
    legacy.sources[2]!,
    { ...legacy.sources[1]!, title: "changed" },
    legacy.sources[0]!,
  ];
  await edit({ frontmatter: { sources: reordered } });
  assert.deepEqual(parseFrontmatter(await adapter.readFile(note)).data.sources, reordered);
  await edit({ frontmatter: { sources: reordered.slice(0, 2) } });
  const before = await adapter.readFile(note);
  await assert.rejects(
    edit({ frontmatter: { sources: [...reordered.slice(0, 2), { resource: invalid }] } }),
    /Invalid sources\[2\]\.resource.*\.\.\/\.\.\/\.\.\/spec\/x.md/,
  );
  await assert.rejects(edit({ frontmatter: { resource: "/../new.md" } }), /Invalid resource:/);
  assert.equal(await adapter.readFile(note), before);
  await edit({ frontmatter: { resource: "../../../spec/x.md", sources: [] } });
});

test("CLI writes retain legacy addresses and report the same repair as node check", async (t) => {
  const { root, adapter, id, note } = await fixture(t);
  await adapter.writeFile(
    note,
    serializeFrontmatter(
      { id, type: "prompt", resource: "/../spec/x.md", sources: [{ resource: "/../spec/x.md" }] },
      "legacy",
    ),
  );
  const cli = (sub: string, args: string[]) =>
    runNodeCommand(sub, args, { workspace: root, json: true });
  const read = JSON.parse((await cli("get", [id, "--full"])).stdout).node;
  const written = await cli("write", [id, "--body", "CLI update", "--base-etag", read.etag]);
  assert.equal(written.exitCode, 0, written.stderr);
  const live = await readNodeForEdit(adapter, id);
  assert.equal(live.body, "CLI update");
  const input = { baseEtag: live.etag, frontmatter: { sources: [{ resource: "/../new.md" }] } };
  const rejected = await cli("write", [id, "--input-json", JSON.stringify(input)]);
  assert.equal(rejected.exitCode, 1);
  assert.match(rejected.stderr, /Invalid sources\[0\]\.resource.*\.\.\/\.\.\/\.\.\/new.md/);
  const checked = await cli("check", [
    id,
    "--input-json",
    JSON.stringify({
      expectedPath: live.path,
      expectedEtag: live.etag,
      materials: [
        {
          resource: "/../spec/x.md",
          canonicalPath: path.join(root, "spec/x.md"),
          observedVersion: "0".repeat(64),
        },
      ],
    }),
  ]);
  assert.equal(checked.exitCode, 1);
  assert.match(checked.stderr, /escapes \.tent; use "\.\.\/\.\.\/\.\.\/spec\/x.md"/);
  assert.equal(await adapter.readFile(note), live.raw);
  for (const fields of [
    { resource: "/../spec/x.md" },
    { sources: [{ resource: "/../spec/x.md" }] },
  ]) {
    const args =
      "resource" in fields
        ? ["--resource", fields.resource!]
        : ["--sources-json", JSON.stringify(fields.sources)];
    const created = await cli("create", ["Rejected", "--type", "output", "--parent", id, ...args]);
    assert.equal(created.exitCode, 1);
    assert.match(
      created.stderr,
      /Invalid (resource|sources\[0\]\.resource):.*\.\.\/\.\.\/\.\.\/\.\.\/spec\/x.md/,
    );
    assert.equal(await adapter.exists("A/B/Rejected"), false);
  }
});

test("root escape repairs preserve encoded path components and query/fragment policy", () => {
  const owner = "A/B/B.md";
  assert.throws(
    () => materialLocator("/%2e%2e/spec/a%23b%3Fc.md?raw=1#part", owner),
    /use "\.\.\/\.\.\/\.\.\/spec\/a%23b%3Fc.md\?raw=1#part"/,
  );
  assert.equal(materialLocator("../../../spec/a%23b%3Fc.md?raw=1#part", owner).kind, "path");
  assert.throws(
    () => materialLocator("/../../outside.md", owner),
    (error: Error) => !error.message.includes("; use"),
  );
  for (const resource of ["./%00name", "/%43%3a/outside", "/%2f%2fserver/share"])
    assert.throws(
      () => validateMaterialAddresses({ sources: [{ resource }] }, owner),
      /Invalid sources\[0\]\.resource:/,
    );
});
