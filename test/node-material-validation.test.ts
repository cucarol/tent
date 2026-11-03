import { removeTestFixture } from "./node-fs.js";
import { openTestFs } from "./node-fs.js";
import { historyHead } from "./scratch.js";
import { initializeFixtureHistory } from "./scratch.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
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
import { testScratchRoot } from "./scratch.js";
import { writeNodesBatch } from "../src/core/write/node-write-batch.js";
import { createRoleContext } from "../src/core/read/role-context.js";
import { createCardDocument } from "../src/core/graph/card-document.js";
import { renameNode } from "../src/core/graph/rename-ops.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "node-material-"));
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  await scaffoldInWorkspace(openTestFs(root), { name: "Materials" });
  const adapter = openTestFs(path.join(root, ".tent"));
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

test("Core edits retain legacy addresses and workspace check reports their repair", async (t) => {
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
  const read = await readNodeForEdit(adapter, id);
  await writeNodeDocument(adapter, id, { baseEtag: read.etag, body: "Core update" });
  const live = await readNodeForEdit(adapter, id);
  assert.equal(live.body, "Core update");
  const input = { baseEtag: live.etag, frontmatter: { sources: [{ resource: "/../new.md" }] } };
  await assert.rejects(
    writeNodeDocument(adapter, id, input),
    (error) =>
      error instanceof NodeWriteError &&
      error.code === "INVALID_EDIT" &&
      /escapes/.test(error.message),
  );
  const checked = await runWorkspaceCommand("check", [], { workspace: root, json: true });
  assert.equal(checked.exitCode, 1, checked.stderr);
  assert.match(checked.stdout, /escapes|outside|invalid-material/i);
  assert.equal(await adapter.readFile(note), live.raw);
  for (const fields of [
    { resource: "/../spec/x.md" },
    { sources: [{ resource: "/../spec/x.md" }] },
  ]) {
    const args =
      "resource" in fields
        ? ["--resource", fields.resource!]
        : ["--source", fields.sources![0]!.resource];
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

test("Card creation keeps path and URI source addresses and rejects ones that name nothing", async (t) => {
  const { root, adapter, env, id, note } = await fixture(t);
  await initializeFixtureHistory(path.join(root, ".tent"));
  await createRoleContext(adapter, { roleId: "role-review", title: "Review", body: "direction" });
  await createRoleContext(adapter, { roleId: "role-old", title: "Old", body: "direction" });
  const rolePath = "roles/role-old.md";
  const sources = [note, rolePath].flatMap((file) => [
    { resource: "/" + file, title: "relative" },
    { resource: pathToFileURL(path.join(root, ".tent", file)).href, title: "URI" },
  ]);
  const saved = await createCardDocument(adapter, {
    prompt: "Original evidence",
    target: "role-review",
    sources,
  });
  assert.deepEqual(parseFrontmatter(await adapter.readFile(saved.path)).data.sources, sources);
  await renameNode(env, id, "Moved");
  await adapter.remove(rolePath);
  assert.equal(await adapter.exists(note), false);
  await adapter.writeFile("attachments/ordinary.md", "ordinary bytes");
  const invalid: MaterialSource[] = [
    ...sources,
    { resource: "/attachments/ordinary.md" },
    {
      resource: "/A/Moved/Moved.md",
      version: { commit: "0".repeat(64), path: "A/Moved/Moved.md" },
    },
  ];
  const head = await historyHead(path.join(root, ".tent"));
  for (let index = 0; index < invalid.length; index++) {
    const cardId = `card-invalid${index}`;
    await assert.rejects(
      createCardDocument(adapter, {
        cardId,
        prompt: "Reject",
        target: "role-review",
        sources: [invalid[index]!],
      }),
    );
    assert.equal(await adapter.exists(`cards/${cardId}.md`), false);
    assert.equal(await historyHead(path.join(root, ".tent")), head);
  }
  await createCardDocument(adapter, {
    prompt: "Moved evidence",
    target: "role-review",
    sources: [{ resource: "/A/Moved/Moved.md" }],
  });
});

test("ordinary .tent files are rejected consistently by new declarations and live observations", async (t) => {
  const { root, adapter, env, id, note } = await fixture(t);
  await initializeFixtureHistory(path.join(root, ".tent"));
  await adapter.writeFile("attachments/ordinary.md", "ordinary bytes");
  await createRoleContext(adapter, { roleId: "role-review", title: "Review", body: "direction" });
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
      createCardDocument(adapter, {
        prompt: "Review",
        target: "role-review",
        sources: [{ resource }],
      }),
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
});

test("file URI Node, Role and Card addresses keep native document and response semantics", async (t) => {
  const { root, adapter, env, note } = await fixture(t);
  await initializeFixtureHistory(path.join(root, ".tent"));
  await createRoleContext(adapter, { roleId: "role-review", title: "Review", body: "direction" });
  const uri = (file: string) => pathToFileURL(path.join(root, ".tent", file)).href;
  const card = await createCardDocument(adapter, {
    prompt: "Review native documents",
    target: "role-review",
    sources: [{ resource: uri(note) }, { resource: uri("roles/role-review.md") }],
  });
  assert.deepEqual(parseFrontmatter(await adapter.readFile(card.path)).data.sources, [
    { resource: uri(note) },
    { resource: uri("roles/role-review.md") },
  ]);
  await createNode(env, {
    parentPath: "",
    name: "Consumer",
    type: "output",
    resource: uri(note),
    sources: [{ resource: uri(card.path) }, { resource: uri("roles/role-review.md") }],
  });
});
