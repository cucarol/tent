/**
 * Legacy `relations` frontmatter is preserved as opaque bytes only.
 * It no longer projects as a first-class Node feature.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { testScratchRoot } from "./scratch.js";
import * as path from "node:path";
import { test } from "node:test";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { readNodeForEdit } from "../src/core/node-query.js";
import { writeNodeDocument } from "../src/core/node-document-write.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { loadTent, nodeNotePath } from "../src/core/tree.js";
import { NodeFs } from "../src/fs/node-fs.js";

async function makeSystemRoot(): Promise<{ systemFs: NodeFs }> {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "tent-core-rel-ws-"));
  const workspaceFs = new NodeFs(workspace);
  await scaffoldInWorkspace(workspaceFs, {
    name: "rel-core",
    nodes: [{ name: "Alpha", type: "prompt", body: "# Alpha\n" }],
  });
  return { systemFs: new NodeFs(path.join(workspace, ".tent")) };
}

async function plantLegacyRelations(systemFs: NodeFs, nodePath: string): Promise<unknown[]> {
  const notePath = nodeNotePath(nodePath);
  const raw = await systemFs.readFile(notePath);
  const parsed = parseFrontmatter(raw);
  const relations = [
    {
      id: "role-11111111",
      kind: "related",
      direction: "directed",
      nodeId: "node-bbbbbb",
    },
    {
      id: "role-22222222",
      kind: "blocks",
      direction: "bidirectional",
      label: "maybe",
      unresolved: "Ghost",
    },
  ];
  parsed.data.relations = relations;
  await systemFs.writeFile(
    notePath,
    serializeFrontmatter(parsed.data, parsed.body, parsed.keyOrder),
  );
  return relations;
}

test("frontmatter round-trips legacy object-array fields", () => {
  const raw = `---
id: node-aaaaaa
type: prompt
relations:
  - {id: role-11111111, kind: related, direction: directed, nodeId: node-bbbbbb}
  - {id: role-22222222, kind: blocks, direction: bidirectional, label: maybe, unresolved: Ghost}
---
# Body
`;
  const parsed = parseFrontmatter(raw);
  assert.ok(Array.isArray(parsed.data.relations));
  const out = serializeFrontmatter(parsed.data, parsed.body, parsed.keyOrder);
  const reparsed = parseFrontmatter(out);
  assert.deepEqual(reparsed.data.relations, parsed.data.relations);
});

test("loadTent keeps legacy relations only on raw frontmatter", async () => {
  const { systemFs } = await makeSystemRoot();
  let tent = await loadTent(systemFs);
  const alpha = [...tent.byId.values()].find((node) => node.name === "Alpha")!;
  const expected = await plantLegacyRelations(systemFs, alpha.path);

  tent = await loadTent(systemFs);
  const loaded = tent.byId.get(alpha.id)!;
  assert.equal(Object.prototype.hasOwnProperty.call(loaded, "relations"), false);
  assert.deepEqual(loaded.fm.relations, expected);
});

test("ordinary body and property writes preserve legacy relations bytes", async () => {
  const { systemFs } = await makeSystemRoot();
  let tent = await loadTent(systemFs);
  const alpha = [...tent.byId.values()].find((node) => node.name === "Alpha")!;
  const expected = await plantLegacyRelations(systemFs, alpha.path);

  let edit = await readNodeForEdit(systemFs, alpha.id);
  await writeNodeDocument(systemFs, alpha.id, { baseEtag: edit.etag, body: "# Updated body\n" });
  edit = await readNodeForEdit(systemFs, alpha.id);
  await writeNodeDocument(systemFs, alpha.id, {
    baseEtag: edit.etag,
    frontmatter: { custom: "value" },
  });

  const afterRaw = await systemFs.readFile(nodeNotePath(alpha.path));
  const after = parseFrontmatter(afterRaw);
  assert.deepEqual(after.data.relations, expected);
  assert.equal(after.data.custom, "value");
  assert.equal(after.body, "# Updated body\n");
});
