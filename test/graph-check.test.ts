import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { checkGraph } from "../src/core/graph-check.js";
import { serializeFrontmatter } from "../src/core/frontmatter.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { createCardDocument } from "../src/core/card-document.js";
import { renameNode } from "../src/core/rename-ops.js";
import { withTentMutation } from "../src/core/adapter.js";
import { testScratchRoot } from "./scratch.js";
import { git } from "./helpers.js";

async function fixture(t: TestContext) {
  const scratch = testScratchRoot();
  const root = await fs.mkdtemp(path.join(scratch, "graph-check-"));
  const workspace = path.join(root, "workspace");
  const systemRoot = path.join(workspace, ".tent");
  await fs.mkdir(systemRoot, { recursive: true });
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(scratch));
    await fs.rm(root, { recursive: true, force: true });
  });
  const adapter = new NodeFs(systemRoot);
  const write = (file: string, data: Record<string, unknown>, body = "") =>
    adapter.writeFile(file, serializeFrontmatter({ type: "prompt", ...data }, body));
  const fileExists = async (filename: string) => {
    try {
      return (await fs.stat(filename)).isFile();
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(String((error as NodeJS.ErrnoException).code)))
        return false;
      throw error;
    }
  };
  return { root, workspace, systemRoot, adapter, write, fileExists };
}

async function bytes(directory: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const file = path.join(directory, entry.name);
    const key = `${prefix}${entry.name}`;
    if (entry.isDirectory()) Object.assign(result, await bytes(file, `${key}/`));
    else result[key] = (await fs.readFile(file)).toString("base64");
  }
  return result;
}

test("whole graph inspection reports the three categories across Nodes, Roles and Cards", async (t) => {
  const { root, workspace, adapter, write, fileExists } = await fixture(t);
  await fs.writeFile(path.join(workspace, "source file.txt"), "material");
  const outside = path.join(root, "outside.txt");
  await fs.writeFile(outside, "explicit file URI outside Workspace");
  await write("Target Name/Target Name.md", { id: "node-target" }, "# part");
  await adapter.writeFile("attachments/linked.pdf", "attachment");
  await adapter.writeFile("Author/node-example.txt", "ordinary local file");
  await write(
    "roles/role-a.md",
    { id: "role-a", type: "role", resource: "/Target%20Name/Target%20Name.md" },
    "[missing](node-absent#part) [target](node-target#unknown-heading)",
  );
  await write(
    "cards/card-a.md",
    {
      id: "card-a",
      type: "card",
      schemaVersion: 3,
      state: "pending",
      sources: [
        { resource: "../missing-card.txt" },
        { resource: "https://example.invalid/material" },
        { resource: "interviews with users" },
        { resource: "looks-like-a-file.pdf" },
        { resource: "file:///bad%ZZ" },
      ],
    },
    "[role](role-a#anything)",
  );
  await write(
    "Author/Author.md",
    {
      id: "node-author",
      resource: "./missing.txt",
      sources: [
        { resource: "../../source%20file.txt?download=1#part" },
        { resource: pathToFileURL(outside).href },
        { resource: "../../../outside.txt" },
        { resource: "//host/material.txt" },
        { resource: "./bad%ZZ" },
        { resource: "./empty-directory" },
      ],
    },
    [
      "[encoded](../Target%20Name/Target%20Name.md#part)",
      "[id](node-target#part) [role](role-a#part) [card](card-a#part)",
      "[legacy node spelling](node-target.md#part) [local file](node-example.txt)",
      "[root](/Target%20Name/Target%20Name.md)",
      "[workspace](../../source%20file.txt)",
      `[outside](${pathToFileURL(outside).href})`,
      "[attachment](../attachments/linked.pdf)",
      "[self](#unverified-anchor) [web](https://example.invalid) [mail](mailto:help@example.invalid)",
      "[missing](../attachments/missing.pdf) [reference][missing-ref]",
      "\n[missing-ref]: ./missing-link.md#part",
      "\n`[code](./missing-code.md)` ![image](./missing-image.png) [[wiki]]",
    ].join("\n"),
  );
  await adapter.mkdir("Author/empty-directory");
  const before = await bytes(root);
  const result = await checkGraph(adapter, workspace, fileExists);
  assert.equal(result.documents, 4);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.issues.map((issue) => issue.kind).sort(), [
    "invalid-material-address",
    "invalid-material-address",
    "invalid-material-address",
    "invalid-material-address",
    "missing-material-file",
    "missing-material-file",
    "missing-material-file",
    "unresolved-link",
    "unresolved-link",
    "unresolved-link",
  ]);
  assert.equal(result.issues.filter((issue) => issue.path === "roles/role-a.md").length, 1);
  assert.equal(result.issues.filter((issue) => issue.path === "cards/card-a.md").length, 2);
  assert.ok(
    result.issues.some(
      (issue) =>
        "resource" in issue && issue.resource === "file:///bad%ZZ" && /URI/.test(issue.reason),
    ),
  );
  assert.deepEqual(await bytes(root), before);
  assert.deepEqual(await checkGraph(adapter, workspace, fileExists), result);
});

test("invalid documents and malformed declarations remain visible and inspectable", async (t) => {
  const { workspace, adapter, write, fileExists } = await fixture(t);
  await write(
    "Invalid/Invalid.md",
    {
      id: "bad-id",
      sources: [null, { resource: 3 }, { resource: "./missing.txt" }],
    },
    "[missing](node-missing)",
  );
  await write("Duplicate/Duplicate.md", { id: "node-duplicate" });
  await write("Other/Other.md", { id: "node-duplicate" });
  await write(
    "Owner/Owner.md",
    { id: "node-owner", sources: "not an array" },
    "[duplicate](node-duplicate) [invalid](../Invalid/Invalid.md)",
  );
  await write("roles/not-a-role.md", { id: "role-valid", type: "role" }, "[missing](./missing.md)");
  await adapter.writeFile("cards/card-bad.md", "---\nsources: [\n---\nbody");
  await adapter.writeBinary("BadUTF8/BadUTF8.md", Uint8Array.from([0xff, 0xff]));
  const result = await checkGraph(adapter, workspace, fileExists);
  assert.equal(result.documents, 7);
  for (const file of [
    "Invalid/Invalid.md",
    "Duplicate/Duplicate.md",
    "Other/Other.md",
    "Owner/Owner.md",
    "roles/not-a-role.md",
    "cards/card-bad.md",
    "BadUTF8/BadUTF8.md",
  ])
    assert.ok(
      result.errors.some((error) => error.path === file),
      file,
    );
  assert.equal(result.issues.filter((issue) => issue.kind === "unresolved-link").length, 4);
  assert.equal(
    result.issues.filter((issue) => issue.kind === "invalid-material-address").length,
    3,
  );
  assert.ok(
    result.issues.some(
      (issue) => issue.kind === "missing-material-file" && issue.path === "Invalid/Invalid.md",
    ),
  );
});

test("retained Card source versions survive live moves and deletion without filesystem or history writes", async (t) => {
  const { root, workspace, systemRoot, adapter, write, fileExists } = await fixture(t);
  await git(systemRoot, "init");
  await write("Original/Original.md", { id: "node-original" }, "retained source");
  await write("roles/role-a.md", { id: "role-a", type: "role" }, "retained role");
  const card = await createCardDocument(adapter, {
    cardId: "card-pinned",
    prompt: "Use selected versions",
    sources: [{ resource: "../Original/Original.md" }, { resource: "../roles/role-a.md" }],
  });
  await renameNode(
    { fs: adapter, clock: { now: () => "2026-10-04T00:00:00.000Z" }, tentName: "test" },
    "Original",
    "Moved",
  );
  await withTentMutation(adapter, async () => {
    await adapter.remove("Moved");
    await adapter.remove("roles/role-a.md");
  });
  await adapter.writeFile("node-move.pending.json", "pending repair must stay unchanged");
  const head = await git(systemRoot, "rev-parse", "HEAD");
  const before = await bytes(root);
  for (const method of [
    "writeFile",
    "writeBinary",
    "mkdir",
    "move",
    "remove",
    "withLock",
    "withDocumentHistory",
  ] as const)
    t.mock.method(adapter, method, () => {
      throw new Error(`Unexpected write: ${method}`);
    });
  assert.deepEqual(await checkGraph(adapter, workspace, fileExists), {
    documents: 1,
    issues: [],
    errors: [],
  });
  assert.equal(await git(systemRoot, "rev-parse", "HEAD"), head);
  assert.deepEqual(await bytes(root), before);
  assert.equal(card.cardId, "card-pinned");
});

test("invalid retained versions report their occurrence instead of checking a live file", async (t) => {
  const { workspace, adapter, write, fileExists } = await fixture(t);
  await write(
    "cards/card-a.md",
    {
      id: "card-a",
      type: "card",
      schemaVersion: 3,
      state: "pending",
      sources: [
        {
          resource: "../Missing/Missing.md",
          version: { commit: "a".repeat(40), path: "Other/Other.md" },
        },
      ],
    },
    "prompt",
  );
  const result = await checkGraph(adapter, workspace, fileExists);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0]!.kind, "invalid-material-address");
  assert.match(result.issues[0]!.reason, /selected Tent Node or Role/);
});

test("file inspection failures are diagnostics, not missing file findings", async (t) => {
  const { workspace, write, adapter } = await fixture(t);
  await write(
    "Author/Author.md",
    { id: "node-author", resource: "./denied.txt" },
    "[denied](./other.txt)",
  );
  const result = await checkGraph(adapter, workspace, async () => {
    throw new Error("EACCES");
  });
  assert.deepEqual(result.issues, []);
  assert.equal(result.errors.length, 2);
  assert.ok(result.errors.every((error) => /EACCES/.test(error.reason)));
});

test("unreadable Node documents and directory areas do not prevent checking healthy siblings", async (t) => {
  const { root, workspace, write, adapter, fileExists } = await fixture(t);
  await write("Denied/Denied.md", { id: "node-denied" }, "unreadable document");
  await write("Hidden/Child/Child.md", { id: "node-hidden" }, "unreadable subtree");
  await write(
    "Healthy/Healthy.md",
    { id: "node-healthy", resource: "./missing.txt" },
    "[missing](node-missing)",
  );
  await write("roles/role-a.md", { id: "role-a", type: "role" }, "unreadable roles area");
  const before = await bytes(root);
  const readFile = adapter.readFile.bind(adapter);
  const readBinary = adapter.readBinary.bind(adapter);
  const listDir = adapter.listDir.bind(adapter);
  t.mock.method(adapter, "readFile", async (file: string) => {
    if (file === "Denied/Denied.md") throw new Error("EACCES: denied Node");
    return readFile(file);
  });
  const deniedBinary = t.mock.method(adapter, "readBinary", async (file: string) => {
    if (file === "Denied/Denied.md") throw new Error("EACCES: denied Node");
    return readBinary(file);
  });
  t.mock.method(adapter, "listDir", async (directory: string) => {
    if (directory === "Hidden" || directory === "roles")
      throw new Error("EACCES: denied directory");
    return listDir(directory);
  });
  for (const method of [
    "writeFile",
    "writeBinary",
    "mkdir",
    "move",
    "remove",
    "withLock",
    "withDocumentHistory",
  ] as const)
    t.mock.method(adapter, method, () => {
      throw new Error(`Unexpected write: ${method}`);
    });
  const result = await checkGraph(adapter, workspace, fileExists);
  assert.equal(result.documents, 2);
  assert.deepEqual(result.errors, [
    { path: "Denied/Denied.md", reason: "EACCES: denied Node" },
    { path: "Hidden", reason: "EACCES: denied directory" },
    { path: "roles", reason: "EACCES: denied directory" },
  ]);
  assert.deepEqual(
    result.issues.map((issue) => [issue.kind, issue.path]),
    [
      ["missing-material-file", "Healthy/Healthy.md"],
      ["unresolved-link", "Healthy/Healthy.md"],
    ],
  );
  deniedBinary.mock.restore();
  assert.deepEqual(await checkGraph(adapter, workspace, fileExists), result);
  assert.deepEqual(await bytes(root), before);
});
