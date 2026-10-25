import assert from "node:assert/strict";
import test from "node:test";
import {
  formatContextBrief,
  inspectCurrentContext,
  makeContextBrief,
  type CurrentContext,
} from "../src/core/read/context-brief.js";
import { loadNodeCatalog } from "../src/core/graph/node-catalog.js";
import { PropagationMemoryFs } from "./propagation-memory.js";

function emptyContext(): CurrentContext {
  return {
    roots: [],
    sync: {
      invalidNodes: [],
      nodes: [],
      counts: { synced: 0, ahead: 0, behind: 0, unanchored: 0 },
      outputNodes: [],
      requirementsWithoutOutputs: [],
    },
    cards: { revision: "fixture", items: [] },
    changedCardSources: { items: [], diagnostics: [] },
  };
}

test("brief counts valid draft Nodes from the catalog and exposes only their count and entry", async () => {
  const fs = new PropagationMemoryFs();
  await fs.writeFile("index.md", '---\nokf_version: "0.2"\n---\n');
  const node = (name: string, fields: string) =>
    fs.writeFile(`${name}/${name}.md`, `---\n${fields}\n---\nPrivate draft body\n`);
  await node("Draft goal", "id: node-draftgoal\ntype: goal\nstatus: draft");
  await node("Draft prompt", "id: node-draftprompt\ntype: prompt\nstatus: draft");
  await node("Draft output", "id: node-draftoutput\ntype: output\nstatus: draft");
  await node("Draft untyped", "id: node-draftuntyped\nstatus: draft");
  await node("Stable", "id: node-stable\ntype: prompt");
  await node("Archived", "id: node-archived\ntype: goal\nstatus: deprecated");
  await node("Invalid", "id: node-invalid\ntype: unknown\nstatus: draft");
  await node("Duplicate A", "id: node-duplicate\ntype: goal\nstatus: draft");
  await node("Duplicate B", "id: node-duplicate\ntype: goal\nstatus: draft");
  await fs.writeFile("roles/role-draft.md", "---\nid: role-draft\nstatus: draft\n---\n");
  await fs.writeFile(
    "cards/card-draft.md",
    "---\nid: card-draft\ntype: card\nschemaVersion: 3\nstate: pending\nstatus: draft\n---\n",
  );
  const catalog = await loadNodeCatalog(fs);
  // A supplied native capture catalog is the same source used for ordinary discovery.
  const context = await inspectCurrentContext(fs, {
    nodes: Promise.resolve({ invalidNodes: [], catalog }),
  });
  assert.equal(context.draftCount, 3);
  const brief = makeContextBrief(context);
  assert.deepEqual(brief.drafts, { count: 3, command: "tent node list --status draft" });
  const text = formatContextBrief(brief);
  assert.equal(text.split("\n")[1], "3 条还没定 · tent node list --status draft");
  assert.doesNotMatch(
    JSON.stringify(brief),
    /node-draft(?:goal|prompt|output)|Draft (?:goal|prompt|output)/,
  );
  assert.doesNotMatch(text, /node-draft(?:goal|prompt|output)|Draft (?:goal|prompt|output)/);
  assert.doesNotMatch(JSON.stringify(brief), /Private draft body/);
  assert.doesNotMatch(text, /Private draft body/);
  assert.equal(
    JSON.stringify(makeContextBrief(await inspectCurrentContext(fs))),
    JSON.stringify(brief),
    "unchanged catalog discovery is deterministic",
  );
});

test("brief preserves transaction recovery conflicts alongside draft discovery", async () => {
  const fs = Object.assign(new PropagationMemoryFs(), { recoveryConflicts: ["B/B.md"] });
  await fs.writeFile(
    "Undecided/Undecided.md",
    "---\nid: node-undecided\ntype: prompt\nstatus: draft\n---\nPrivate draft body\n",
  );
  const context = await inspectCurrentContext(fs);
  assert.deepEqual(context.recoveryConflicts, ["B/B.md"]);
  assert.equal(context.draftCount, 1);
  const brief = makeContextBrief(context);
  assert.deepEqual(brief.recoveryConflicts, ["B/B.md"]);
  assert.deepEqual(brief.drafts, { count: 1, command: "tent node list --status draft" });
  const text = formatContextBrief(brief);
  assert.match(text, /Transaction recovery kept external edits:\n- \.tent\/B\/B.md/);
  assert.match(text, /1 条还没定 · tent node list --status draft/);
  assert.doesNotMatch(text, /Private draft body/);
});

test("without draft Nodes brief preserves its JSON and text shape", async () => {
  const fs = new PropagationMemoryFs();
  const context = await inspectCurrentContext(fs);
  assert.equal(Object.prototype.hasOwnProperty.call(context, "draftCount"), false);
  const brief = makeContextBrief(context);
  assert.deepEqual(brief, {
    counts: { ahead: 0, behind: 0 },
    invalidNodes: [],
    cardInputs: [],
    ahead: [],
    changedCardSources: [],
    behind: [],
    roots: [],
    baselineOnlyBehind: 0,
    omitted: { roots: 0, behind: 0, ahead: 0, cardInputs: 0, changedCardSources: 0 },
  });
  assert.equal(formatContextBrief(brief), "behind 0 · ahead 0");
});

test("draft discovery leaves the full optional detail budget available in both forms", () => {
  const context = emptyContext();
  const node = {
    nodeId: "node-behind",
    path: "P/Named",
    type: "prompt",
    state: "behind" as const,
    trustTier: "unverified" as const,
    stale: false,
    behind: { reasons: ["Material changed"] },
    materials: [],
    reasons: [],
  };
  context.sync.nodes.push(node);
  context.sync.counts.behind = 1;
  const initialSize = Buffer.byteLength(JSON.stringify(makeContextBrief(context)) + "\n");
  node.path = "P".repeat(4096 - initialSize + 1) + "/Named";
  const withoutDrafts = makeContextBrief(context);
  assert.equal(withoutDrafts.behind.length, 1);
  assert.equal(Buffer.byteLength(JSON.stringify(withoutDrafts) + "\n"), 4096);
  assert.ok(Buffer.byteLength(formatContextBrief(withoutDrafts) + "\n") <= 4096);

  const withDrafts = makeContextBrief({ ...context, draftCount: 1 });
  const { drafts, ...optionalDetails } = withDrafts;
  assert.deepEqual(optionalDetails, withoutDrafts);
  assert.deepEqual(drafts, { count: 1, command: "tent node list --status draft" });
  assert.ok(Buffer.byteLength(JSON.stringify(withDrafts) + "\n") > 4096);
  assert.equal(
    formatContextBrief(withDrafts).replace("1 条还没定 · tent node list --status draft\n", ""),
    formatContextBrief(withoutDrafts),
  );
});

test("draft discovery remains visible when mandatory Cards already exceed the detail budget", () => {
  const context = emptyContext();
  context.cards.items = Array.from({ length: 50 }, (_, i) => ({
    cardId: `card-${i}`,
    state: "pending",
    title: "Mandatory Card ".repeat(6),
  }));
  const withoutDrafts = makeContextBrief(context);
  const withDrafts = makeContextBrief({ ...context, draftCount: 2 });
  const { drafts: _drafts, ...details } = withDrafts;
  assert.deepEqual(details, withoutDrafts);
  assert.ok(Buffer.byteLength(JSON.stringify(withoutDrafts)) > 4096);
  assert.equal(withDrafts.cardInputs.length, 50);
  assert.equal(
    formatContextBrief(withDrafts).split("\n")[1],
    "2 条还没定 · tent node list --status draft",
  );
});
