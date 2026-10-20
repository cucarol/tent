import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { createNode } from "../src/core/graph/ops.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/base/frontmatter.js";
import {
  materialLocator,
  validateMaterialAddresses,
  type MaterialSource,
} from "../src/core/base/material.js";
import { NodeWriteError, writeNodeDocument } from "../src/core/graph/node-document-write.js";
import { readNodeForEdit } from "../src/core/read/node-query.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { testScratchRoot } from "./scratch.js";
import type { FsAdapter } from "../src/core/store/adapter.js";
import {
  observeNodeMaterials,
  nodeSemanticFingerprint,
  nodeMaterialObservationScope,
} from "../src/core/graph/node-sync-record.js";
import { writeNodesBatch } from "../src/core/write/node-write-batch.js";
import {
  createRoleContext,
  editRoleContext,
  requireRoleDocument,
} from "../src/core/read/role-context.js";
import { createCardDocument, verifyCardSourceVersion } from "../src/core/graph/card-document.js";
import { renameNode } from "../src/core/graph/rename-ops.js";
import { git } from "./helpers.js";

test("query observations distinguish descriptive sources from file resources", async () => {
  let reads = 0;
  const adapter = {
    observeMaterial: async () => {
      reads++;
      return { observedVersion: "a".repeat(64) };
    },
  } as unknown as FsAdapter;
  const data = {
    resource: "../../notes.md",
    sources: [{ resource: "notes.md" }, { resource: "../../notes.md" }],
  };
  const expected = await observeNodeMaterials(adapter, data, "A/A.md");
  reads = 0;
  const actual = await observeNodeMaterials(
    adapter,
    data,
    "A/A.md",
    undefined,
    undefined,
    nodeMaterialObservationScope(new Map()),
  );
  assert.deepEqual(actual, expected);
  assert.equal(actual[1]!.version, undefined);
  assert.match(actual[1]!.reason!, /not an explicit local address/);
  assert.equal(reads, 1);
});

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "node-material-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await scaffoldInWorkspace(new NodeFs(root), { name: "Materials" });
  const adapter = new NodeFs(path.join(root, ".tent"));
  const env = {
    fs: adapter,
    clock: { now: () => "2026-10-04T00:00:00.000Z" },
    tentName: "Materials",
  };
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
    resource: "../../../spec/main.md",
    sources: [
      { resource: "note: reference" },
      { resource: "75% of interviews" },
      { resource: "../../../spec/missing%20file.md#part?raw=1" },
      { resource: "../../../missing/file.md?raw=1#part" },
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
    sources: [
      { resource: "ordinary description" },
      { resource: "../../../missing%23name.md#part" },
    ],
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

test("CLI writes retain legacy addresses and read-only node check reports their repair", async (t) => {
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
  const read = JSON.parse((await cli("get", [id, "--full"])).stdout);
  const written = await cli("write", [id, "--body", "CLI update", "--base-etag", read.etag]);
  assert.equal(written.exitCode, 0, written.stderr);
  const live = await readNodeForEdit(adapter, id);
  assert.equal(live.body, "CLI update");
  const input = { baseEtag: live.etag, frontmatter: { sources: [{ resource: "/../new.md" }] } };
  const rejected = await cli("write", [id, "--input-json", JSON.stringify(input)]);
  assert.equal(rejected.exitCode, 1);
  assert.match(rejected.stderr, /Material outside the Workspace requires an absolute URI/);
  const checked = await cli("check", [id]);
  assert.equal(checked.exitCode, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).state, "unanchored");
  assert.match(
    JSON.parse(checked.stdout).materials[0].reason,
    /escapes \.tent; use "\.\.\/\.\.\/\.\.\/spec\/x.md"/,
  );
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
    assert.match(created.stderr, /Material outside the Workspace requires an absolute URI/);
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

test("Card creation validates pinned path and URI sources after live rename or deletion", async (t) => {
  const { root, adapter, env, id, note } = await fixture(t);
  await git(path.join(root, ".tent"), "init", "--quiet");
  await createRoleContext(adapter, { roleId: "role-review", title: "Review", body: "direction" });
  const rolePath = "roles/role-review.md";
  const saved = await createCardDocument(adapter, {
    prompt: "Original evidence",
    sources: [note, rolePath].flatMap((file) => [
      { resource: "/" + file, title: "relative" },
      { resource: pathToFileURL(path.join(root, ".tent", file)).href, title: "URI" },
    ]),
  });
  const sources = parseFrontmatter(await adapter.readFile(saved.path)).data
    .sources as MaterialSource[];
  const original = await Promise.all(
    sources.map((source) => verifyCardSourceVersion(adapter, saved.path, source)),
  );
  await renameNode(env, id, "Moved");
  await adapter.remove(rolePath);
  assert.equal(await adapter.exists(note), false);
  const forwarded = await createCardDocument(adapter, { prompt: "Use retained evidence", sources });
  assert.deepEqual(parseFrontmatter(await adapter.readFile(forwarded.path)).data.sources, sources);
  for (let index = 0; index < sources.length; index++)
    assert.equal(
      (await verifyCardSourceVersion(adapter, forwarded.path, sources[index]!)).raw,
      original[index]!.raw,
    );

  await adapter.writeFile("attachments/ordinary.md", "ordinary bytes");
  const pinned = sources[0]!;
  const invalid: MaterialSource[] = [
    { ...pinned, version: { ...pinned.version!, commit: "0".repeat(40) } },
    { ...pinned, resource: "/A/Moved/Moved.md" },
    { resource: "/attachments/ordinary.md" },
    {
      resource: "/attachments/ordinary.md",
      version: { ...pinned.version!, path: "attachments/ordinary.md" },
    },
  ];
  const head = await git(path.join(root, ".tent"), "rev-parse", "HEAD");
  for (let index = 0; index < invalid.length; index++) {
    const cardId = `card-invalid${index}`;
    await assert.rejects(
      createCardDocument(adapter, { cardId, prompt: "Reject", sources: [invalid[index]!] }),
    );
    assert.equal(await adapter.exists(`cards/${cardId}.md`), false);
    assert.equal(await git(path.join(root, ".tent"), "rev-parse", "HEAD"), head);
  }
});

test("ordinary .tent files are rejected consistently by new declarations and live observations", async (t) => {
  const { root, adapter, env, id, note } = await fixture(t);
  await git(path.join(root, ".tent"), "init", "--quiet");
  await adapter.writeFile("attachments/ordinary.md", "ordinary bytes");
  await createRoleContext(adapter, { roleId: "role-review", title: "Review", body: "direction" });
  const role = await requireRoleDocument(adapter, "role-review");
  const live = await readNodeForEdit(adapter, id);
  for (const resource of [
    "/attachments/ordinary.md",
    pathToFileURL(path.join(root, ".tent/attachments/ordinary.md")).href,
    "/canvas.json",
    "/.git/config",
    "/attachments/",
    "/attach*",
    "/Missing/Missing.md",
    "/roles/role-missing.md",
  ]) {
    await assert.rejects(
      createNode(env, { parentPath: "", name: "Rejected", type: "output", resource }),
      /Materials must point/,
    );
    for (const input of [
      { frontmatter: { sources: [{ resource }] } },
      { raw: serializeFrontmatter({ ...live.frontmatter, resource }, live.body) },
    ])
      await assert.rejects(
        writeNodeDocument(adapter, id, { baseEtag: live.etag, ...input }),
        /Materials must point/,
      );
    await assert.rejects(
      writeNodesBatch(env, {
        items: [
          { op: "create", ref: "first", parent: null, name: "First", type: "prompt" },
          { op: "create", ref: "second", parent: null, name: "Second", type: "output", resource },
        ],
      }),
      /Materials must point/,
    );
    await assert.rejects(
      editRoleContext(adapter, "role-review", { baseEtag: role.etag, frontmatter: { resource } }),
      /Materials must point/,
    );
    await assert.rejects(
      createCardDocument(adapter, { prompt: "Review", sources: [{ resource }] }),
      /Materials must point/,
    );
    await assert.rejects(adapter.observeMaterial(resource, note), /Materials must point/);
    assert.equal(await adapter.readFile(note), live.raw);
    assert.equal(await adapter.exists("First"), false);
    assert.equal(await adapter.exists("Rejected"), false);
  }
  // Old declarations can be repaired incrementally without implicitly trusting their bytes.
  if (process.platform === "win32")
    await assert.rejects(
      adapter.observeMaterial("../../../.TENT/attachments/ordinary.md", note),
      /Materials must point/,
    );
  const legacy = serializeFrontmatter(
    { ...live.frontmatter, resource: "/attachments/ordinary.md" },
    "legacy",
  );
  await adapter.writeFile(note, legacy);
  const retained = await readNodeForEdit(adapter, id);
  await writeNodeDocument(adapter, id, { baseEtag: retained.etag, body: "editable legacy" });
  const observed = await observeNodeMaterials(
    adapter,
    { resource: "/attachments/ordinary.md" },
    note,
  );
  assert.equal(observed[0]!.version, undefined);
  assert.match(observed[0]!.reason!, /Materials must point/);
});

test("file URI Node, Role and Card addresses retain native history and response semantics", async (t) => {
  const { root, adapter, env, note } = await fixture(t);
  await git(path.join(root, ".tent"), "init", "--quiet");
  await createRoleContext(adapter, { roleId: "role-review", title: "Review", body: "direction" });
  const uri = (file: string) => pathToFileURL(path.join(root, ".tent", file)).href;
  const card = await createCardDocument(adapter, {
    prompt: "Review native documents",
    sources: [{ resource: uri(note) }, { resource: uri("roles/role-review.md") }],
  });
  const sources = parseFrontmatter(await adapter.readFile(card.path)).data.sources as Array<{
    resource: string;
    version: { path: string };
  }>;
  assert.deepEqual(
    sources.map((source) => source.resource),
    [uri(note), uri("roles/role-review.md")],
  );
  assert.deepEqual(
    sources.map((source) => source.version.path),
    [note, "roles/role-review.md"],
  );
  await createNode(env, {
    parentPath: "",
    name: "Consumer",
    type: "output",
    resource: uri(note),
    sources: [{ resource: uri(card.path) }, { resource: uri("roles/role-review.md") }],
  });
  const native = await observeNodeMaterials(
    adapter,
    { resource: `/${note}` },
    "Consumer/Consumer.md",
  );
  const absolute = await observeNodeMaterials(
    adapter,
    { resource: uri(note) },
    "Consumer/Consumer.md",
  );
  assert.equal(absolute[0]!.version, native[0]!.version);
  assert.ok(absolute[0]!.version);
  assert.deepEqual(
    await observeNodeMaterials(adapter, { sources: [{ resource: uri(card.path) }] }, note),
    [],
  );
  assert.equal(
    nodeSemanticFingerprint(
      { sources: [{ resource: uri(card.path) }] },
      "body",
      note,
      undefined,
      root,
    ),
    nodeSemanticFingerprint({}, "body", note, undefined, root),
  );
});
