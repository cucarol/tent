import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import fs from "node:fs/promises";
import { NodeFs } from "../src/fs/node-fs.js";
import { serializeFrontmatter } from "../src/core/base/frontmatter.js";
import { createCardDocument } from "../src/core/graph/card-document.js";
import { assembleAgentContext } from "../src/core/read/agent-context.js";
import {
  captureFixtureDocuments,
  historyHead,
  initializeFixtureWorkspace,
  testScratchRoot,
} from "./scratch.js";

test("SQLite context keeps pinned identity across live path reuse and reads minimal retained diffs without capture", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "agent-context-sqlite-"));
  const system = path.join(root, ".tent");
  let adapter: NodeFs | undefined;
  t.after(async () => {
    await adapter?.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });
  await initializeFixtureWorkspace(root);
  const fields = { id: "node-task", type: "goal", resource: "../../src/a.ts" };
  const oldBody = "Intro.\n## Rule\nOld rule.\nUntouched context.\n";
  await fs.mkdir(path.join(system, "Task"));
  await fs.writeFile(path.join(system, "Task/Task.md"), serializeFrontmatter(fields, oldBody));
  await captureFixtureDocuments(system);
  const pin = { commit: await historyHead(system), path: "Task/Task.md" };
  assert.match(pin.commit, /^[a-f0-9]{64}$/);
  adapter = new NodeFs(system, "cli");
  await adapter.ready();
  const card = await createCardDocument(adapter, {
    cardId: "card-sqlitecontext",
    prompt: "Read node-task「Rule」.",
    sources: [
      { resource: "../Task/Task.md#Rule", version: pin },
      { resource: "../Task/Task.md#Missing", version: pin },
    ],
  });
  await adapter.close();
  adapter = undefined;
  await fs.mkdir(path.join(system, "Moved"));
  await fs.writeFile(
    path.join(system, "Moved/Moved.md"),
    serializeFrontmatter(fields, oldBody.replace("Old rule.", "New rule.")),
  );
  await fs.writeFile(
    path.join(system, "Task/Task.md"),
    serializeFrontmatter(
      { id: "node-imposter", type: "goal", resource: "../../src/imposter.ts" },
      "## Rule\nWrong identity.\n## Missing\nOnly the new occupant has this section.",
    ),
  );
  await captureFixtureDocuments(system);
  assert.ok((await fs.stat(path.join(system, ".git/history.sqlite"))).isFile());
  await assert.rejects(fs.stat(path.join(system, ".git/HEAD")), { code: "ENOENT" });
  const before = {
    head: await historyHead(system),
    card: await fs.readFile(path.join(system, card.path), "utf8"),
    moved: await fs.readFile(path.join(system, "Moved/Moved.md"), "utf8"),
    reused: await fs.readFile(path.join(system, "Task/Task.md"), "utf8"),
  };
  adapter = new NodeFs(system, "cli");
  await adapter.ready();
  const value = await assembleAgentContext(
    adapter,
    root,
    { kind: "card", cardId: card.cardId },
    { repository: { trackedFiles: [], sources: { files: [], errors: [] } } },
  );
  const section = (kind: string) => value.sections.find((section) => section.kind === kind)!;
  const sources = section("references").items.filter((item) => item.nodeId === "node-task");
  assert.equal(sources.length, 2);
  assert.ok(
    sources.every((item) => item.version?.commit === pin.commit && item.version.path === pin.path),
  );
  assert.match(sources.find((item) => item.heading === "Rule")!.text!, /^## Rule\nOld rule/);
  assert.equal(sources.find((item) => !item.heading)!.text, oldBody);
  assert.ok(!JSON.stringify(section("references")).includes("Wrong identity"));
  assert.ok(
    section("unknown").items.some(
      (item) => item.why.includes("Missing") && item.version?.commit === pin.commit,
    ),
  );
  assert.deepEqual(
    section("paths").items.map((item) => item.path),
    ["src/a.ts"],
  );
  const diff = section("changes").items.find((item) => item.nodeId === "node-task")!.text!;
  assert.ok(diff.includes("\n-Old rule.\n+New rule.\n"));
  assert.ok(!diff.includes("\n-Intro.") && !diff.includes("\n+Intro."));
  assert.ok(diff.includes("Task/Task.md") && diff.includes("Moved/Moved.md"));
  assert.deepEqual(
    await assembleAgentContext(adapter, root, value.start, {
      repository: { trackedFiles: [], sources: { files: [], errors: [] } },
    }),
    value,
  );
  await adapter.close();
  adapter = undefined;
  assert.deepEqual(
    {
      head: await historyHead(system),
      card: await fs.readFile(path.join(system, card.path), "utf8"),
      moved: await fs.readFile(path.join(system, "Moved/Moved.md"), "utf8"),
      reused: await fs.readFile(path.join(system, "Task/Task.md"), "utf8"),
    },
    before,
  );
});
