import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { testScratchRoot } from "./scratch.js";
import * as path from "node:path";
import { test } from "node:test";
import { contentEtag } from "../src/core/etag.js";
import { loadTent, nodeNotePath, reloadLoadedNode } from "../src/core/tree.js";
import { NodeFs } from "../src/fs/node-fs.js";

test("Node load and reload retain the exact raw document etag", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "tent-node-etag-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  const nodeFs = new NodeFs(root);
  const nodePath = "etag-node";
  const notePath = nodeNotePath(nodePath);
  const initialRaw = "---\nid: node-etagnode\ntype: prompt\n---\n# initial\n";
  await nodeFs.mkdir(nodePath);
  await nodeFs.writeFile(notePath, initialRaw);

  const tent = await loadTent(nodeFs);
  const node = tent.byId.get("node-etagnode");
  assert.ok(node);
  assert.equal(node.etag, contentEtag(initialRaw));

  const updatedRaw = "---\nid: node-etagnode\ntype: prompt\n---\n# updated\n";
  await nodeFs.writeFile(notePath, updatedRaw);
  const reloaded = await reloadLoadedNode(nodeFs, tent, nodePath);
  assert.equal(reloaded, node);
  assert.equal(reloaded.etag, contentEtag(updatedRaw));
  assert.notEqual(reloaded.etag, contentEtag(initialRaw));
});
