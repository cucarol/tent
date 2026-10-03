import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NodeFs } from "../src/fs/node-fs.js";
import { initializeTentWorkspace } from "../src/fs/workspace-init.js";
import { contentEtag } from "../src/core/etag.js";
import { readNode, listNodes, relatedNodes } from "../src/core/node-query.js";
import { readWorkspaceSettings } from "../src/core/workspace-settings.js";
import { runNodeCommand } from "../src/cli/node-commands.js";

const raw = (id: string, body: string, extra = "") =>
  `\uFEFF---\r\nid: ${id}\r\ntype: prompt\r\n${extra}---\r\n${body}`;

test("public discovery uses only headers, omits edit tokens and keeps metadata paging separate from body versions", async (t) => {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "node-discovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await initializeTentWorkspace(workspace);
  const adapter = new NodeFs(path.join(workspace, ".tent"));
  const original = raw("node-alpha", "A".repeat(128 * 1024), "tags: [offline, PDF]\r\n");
  await adapter.writeFile("A/A.md", original);
  await adapter.writeFile("A/Child/Child.md", raw("node-child", "Child"));
  const largeTags = Array.from({ length: 150 }, (_, i) => `tag-${i}-${"字".repeat(50)}`);
  await adapter.writeFile(
    "B/B.md",
    raw("node-bravo", "B", `tags: ${JSON.stringify(largeTags)}\r\n`),
  );
  await adapter.writeFile(
    "Hidden/Hidden.md",
    raw("node-hidden", "Hidden", "status: deprecated\r\n"),
  );
  for (let i = 0; i < 30; i++)
    await adapter.writeFile(`N${i}/N${i}.md`, raw(`node-other${i}`, "Other".repeat(30000)));
  {
    const { workspaceId: savedId } = await readWorkspaceSettings(adapter);
    const workspaceId = savedId!;
    const mountedFs = adapter;
    const read = mountedFs.readFile.bind(mountedFs);
    const fullReads: string[] = [];
    mountedFs.readFile = async (name) => {
      if (name.endsWith(".md")) fullReads.push(name);
      return read(name);
    };
    const list = (input = {}) => listNodes(adapter, workspaceId, input);
    const first = await list();
    assert.equal(first.items[0]!.nodeId, "node-alpha");
    assert.equal("etag" in first.items[0]!, false);
    assert.ok(first.items.length > 30);
    const globals = { workspace, json: true };
    const summary = await runNodeCommand("get", ["node-alpha", "--view", "summary"], globals);
    assert.equal(summary.exitCode, 0, summary.stderr);
    assert.deepEqual(JSON.parse(summary.stdout).node.tags, ["offline", "PDF"]);
    assert.equal("etag" in JSON.parse(summary.stdout).node, false);
    const children = await relatedNodes(adapter, workspaceId, {
      nodeId: "node-alpha",
      direction: "children",
    });
    assert.deepEqual(
      children.items.map((n) => n.nodeId),
      ["node-child"],
    );
    const parent = await relatedNodes(adapter, workspaceId, {
      nodeId: "node-child",
      direction: "parent",
    });
    assert.equal(parent.items[0]!.nodeId, "node-alpha");
    assert.equal(
      (await list()).items.some((n) => n.nodeId === "node-hidden"),
      false,
    );
    assert.equal(
      (await list({ includeArchived: true })).items.some((n) => n.nodeId === "node-hidden"),
      true,
    );
    const large = await readNode(adapter, workspaceId, { nodeId: "node-bravo", view: "summary" });
    assert.deepEqual(large.node.tags, largeTags);

    const edited = original + "external body edit";
    await fs.writeFile(path.join(workspace, ".tent/A/A.md"), edited);
    const second = await list();
    assert.equal(second.items.find((item) => item.nodeId === "node-bravo")?.nodeId, "node-bravo");
    assert.equal(second.revision, first.revision);
    assert.deepEqual(fullReads, []);
    await assert.rejects(
      promisify(execFile)(
        "git",
        ["-C", path.join(workspace, ".tent"), "rev-parse", "--verify", "HEAD"],
        { windowsHide: true },
      ),
    );
    for (const params of [
      { expectedEtag: contentEtag(edited) },
      { range: { unit: "utf16", start: 0, end: 0 } },
    ]) {
      await assert.rejects(
        readNode(adapter, workspaceId, { nodeId: "node-alpha", view: "summary", ...params }),
      );
    }
    const body = await readNode(adapter, workspaceId, { nodeId: "node-alpha", capture: true });
    assert.ok("text" in body.node && body.node.version);
    assert.equal(body.node.etag, contentEtag(edited));
    assert.equal(await adapter.history.read(body.node.version), edited);
    assert.deepEqual(fullReads, ["A/A.md"]);
    await fs.writeFile(
      path.join(workspace, ".tent/A/A.md"),
      edited.replace("[offline, PDF]", "[online]"),
    );
    assert.notEqual((await list()).revision, first.revision);
    assert.deepEqual(
      (await readNode(adapter, workspaceId, { nodeId: "node-alpha", view: "summary" })).node.tags,
      ["online"],
    );
    assert.notEqual((await list()).revision, first.revision);
  }
});
