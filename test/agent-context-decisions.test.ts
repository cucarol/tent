import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import nativeFs from "node:fs/promises";
import { PropagationMemoryFs } from "./propagation-memory.js";
import { scaffoldTent } from "../src/core/store/scaffold.js";
import { serializeFrontmatter } from "../src/core/base/frontmatter.js";
import {
  assembleAgentContext,
  type AgentContext,
  type AgentContextRepository,
} from "../src/core/read/agent-context.js";
import { projectAgentContext } from "../src/core/read/agent-context-page.js";
import { checkGraph } from "../src/core/check/graph-check.js";
import { createCardDocument } from "../src/core/graph/card-document.js";
import { readCardBodyReferences } from "../src/core/read/card-references.js";
const root = path.resolve(".scratch/decisions-cli/memory");
const section = (value: AgentContext, kind: string) =>
  value.sections.find((item) => item.kind === kind)!;
async function fixture() {
  const fs = new PropagationMemoryFs();
  await scaffoldTent(fs, { name: "Decision" });
  const snapshots = new Map<string, Map<string, string>>();
  const capture = fs.history.captureUnlocked.bind(fs.history);
  fs.history.captureUnlocked = async (...args) => {
    const value = await capture(...args);
    if (value.commit) snapshots.set(value.commit, new Map(fs.files));
    return value;
  };
  fs.history.readDirectory = async (commit, directory) =>
    new Map(
      [...(snapshots.get(commit) ?? [])].filter(
        ([file]) => directory === undefined || file.startsWith(directory + "/"),
      ),
    );
  fs.history.completedCardPaths = async () => new Set();
  fs.history.diff = async () => "";
  const node = (folder: string, id: string, type: string, body = "", extra = {}) =>
    fs.writeFile(
      `${folder}/${path.posix.basename(folder)}.md`,
      serializeFrontmatter({ id, type, ...extra }, body),
    );
  const save = async () =>
    (
      await fs.history.captureUnlocked(
        [...fs.files].map(([path, raw]) => ({ path, raw })),
        { operation: "test.capture" },
      )
    ).commit!;
  const card = (id: string, body: string, sources: object[] = []) =>
    fs.writeFile(
      `cards/${id}.md`,
      serializeFrontmatter({ id, type: "card", schemaVersion: 3, state: "pending", sources }, body),
    );
  return { fs, node, save, card };
}
const repo: AgentContextRepository = {
  trackedFiles: ["src/a.ts", "src/b.ts", "test/a.test.ts", "test/b.test.ts"],
  sources: {
    errors: [],
    files: [
      { path: "src/a.ts", content: "export function A(){}" },
      { path: "src/b.ts", content: "export function B(){}" },
      { path: "test/a.test.ts", content: "import {A} from '../src/a'; A();" },
      { path: "test/b.test.ts", content: "import {B} from '../src/b'; B();" },
    ],
  },
};
test("decisions scope: only sources expand work; body citations, code examples and ancestors cannot widen it", async () => {
  const { fs, node, save, card } = await fixture();
  await node("Project", "node-project", "goal", "Project rule.");
  await node("Project/Task", "node-task", "goal", "Do A.", { resource: "../../../src/a.ts" });
  await node("Project/Task/Child", "node-child", "goal");
  await node("Project/Task/Child/Deep", "node-deep", "goal");
  await node("Project/Task/Draft", "node-draft", "goal", "", { status: "draft" });
  await node("Project/Task/Old", "node-old", "goal", "", { status: "deprecated" });
  await node("Incidental", "node-incidental", "goal", "Incidental reference.", {
    resource: "../../src/b.ts",
  });
  await node("Fenced", "node-fenced", "goal");
  await node("Inline", "node-inline", "goal");
  const basis = await save();
  await card(
    "card-work",
    "See node-incidental and src/b.ts. `node-inline` is a code example.\n```text\nnode-fenced\nsrc/b.ts\n```",
    [
      {
        resource: "../Project/Task/Task.md",
        version: { commit: basis, path: "Project/Task/Task.md" },
      },
    ],
  );
  await card("card-bodyonly", "Only a citation: node-task.");
  await card("card-legacysource", "An explicit legacy source.", [
    { resource: "../Project/Task/Task.md" },
  ]);
  await save();
  const value = await assembleAgentContext(
    fs,
    root,
    { kind: "card", cardId: "card-work" },
    { repository: repo },
  );
  assert.deepEqual(
    section(value, "tests").items.map((item) => item.path),
    ["test/a.test.ts"],
  );
  assert.ok(!section(value, "paths").items.some((item) => item.path === "src/b.ts"));
  assert.ok(section(value, "decisions").items.some((item) => item.nodeId === "node-incidental"));
  assert.ok(section(value, "decisions").items.some((item) => item.path === "src/b.ts"));
  assert.ok(!JSON.stringify(value).includes('"nodeId":"node-fenced"'));
  assert.ok(!section(value, "decisions").items.some((item) => item.nodeId === "node-inline"));
  const goals = section(value, "open")
    .items.filter((item) => item.nodeId)
    .map((item) => item.nodeId)
    .sort();
  assert.deepEqual(goals, ["node-child", "node-task"]);
  assert.deepEqual(
    section(value, "open")
      .items.filter((item) => item.cardId)
      .map((item) => item.cardId)
      .sort(),
    ["card-legacysource", "card-work"],
  );
  assert.ok(section(value, "rules").items.some((item) => item.nodeId === "node-project"));
});

test("prose missing IDs leave unknown room for established selector errors in Card and Node starts", async () => {
  const { fs, node, save, card } = await fixture();
  const noise = Array.from({ length: 20 }, (_, index) => `node-missing${index}`);
  const body = [
    noise.join(", "),
    "[unknown id](node-nope00) `node-inline` `node-rule「Missing」`",
    "node-rule「Keep」 node-rule「Missing」 node-rule「Repeat」",
    "```\nnode-inline\n```",
  ].join("\n");
  await node("Module", "node-module", "goal", "Module rules.", {
    sources: [{ resource: "../../src/", track: "structure" }],
  });
  await node("Module/Task", "node-task", "goal", body, { resource: "../../../src/a.ts" });
  await node(
    "Rule",
    "node-rule",
    "prompt",
    "## Keep\nKept rule.\n## Repeat\nfirst\n## Repeat\nsecond",
  );
  await node("Inline", "node-inline", "prompt", "Code-only example.");
  const pin = await save();
  await card("card-prose", body, [
    { resource: "../Module/Task/Task.md", version: { commit: pin, path: "Module/Task/Task.md" } },
  ]);
  await card("card-explicit", "node-missing99", [{ resource: "node-nope00" }]);
  await save();
  const before = [...fs.files];
  for (const start of [
    { kind: "node" as const, nodeId: "node-task" },
    { kind: "card" as const, cardId: "card-prose" },
  ]) {
    const value = await assembleAgentContext(fs, root, start, { repository: repo });
    const unknown = section(value, "unknown");
    assert.ok(unknown.total < 10, JSON.stringify(unknown));
    assert.equal(unknown.omitted, 0);
    assert.ok(!unknown.items.some((item) => /node-missing\d+|node-nope00/.test(item.why)));
    assert.ok(
      unknown.items.some((item) => item.why.includes("Missing")),
      JSON.stringify(unknown),
    );
    assert.ok(
      unknown.items.some((item) => item.why.includes("duplicated")),
      JSON.stringify(unknown),
    );
    assert.ok(
      section(value, "decisions").items.some(
        (item) =>
          item.nodeId === "node-rule" &&
          item.heading === "Keep" &&
          item.text?.includes("Kept rule."),
      ),
    );
    assert.ok(!section(value, "decisions").items.some((item) => item.nodeId === "node-inline"));
    assert.deepEqual(
      section(value, "tests").items.map((item) => item.path),
      ["test/a.test.ts"],
    );
  }
  const explicit = await assembleAgentContext(
    fs,
    root,
    { kind: "card", cardId: "card-explicit" },
    { repository: repo },
  );
  assert.ok(
    section(explicit, "unknown").items.some((item) =>
      item.why.includes("Legacy Card source node-nope00"),
    ),
  );
  const checked = await checkGraph(fs, root, async () => true);
  assert.ok(
    checked.issues.some(
      (issue) =>
        issue.kind === "unresolved-link" &&
        issue.path === "cards/card-prose.md" &&
        issue.target === "node-nope00",
    ),
  );
  assert.deepEqual([...fs.files], before);
});
test("explicit historical pins keep their identity and ambiguity after deletion before Card publication", async () => {
  const { fs, node, save } = await fixture();
  await node("Target", "node-target", "prompt", "## Exact\nFirst pinned rule.");
  const first = await save();
  await node("Target", "node-target", "prompt", "## Exact\nSecond pinned rule.");
  const second = await save();
  await fs.remove("Target");
  await fs.history.captureUnlocked([{ path: "Target/Target.md", raw: null }], {
    operation: "test.delete-before-publication",
  });
  const prompt =
    "Read node-target「Exact」 and [the same rule](node-target#Exact). node-nope00 `node-target「Missing」`.";
  const source = (commit: string) => ({
    resource: "../Target/Target.md",
    version: { commit, path: "Target/Target.md" },
  });
  const conflicted = await createCardDocument(fs, {
    cardId: "card-pinsdeleted",
    prompt,
    sources: [source(first), source(second)],
  });
  const single = await createCardDocument(fs, {
    cardId: "card-singledeleted",
    prompt,
    sources: [source(first)],
  });
  const published = await readCardBodyReferences(fs, conflicted.cardId);
  assert.deepEqual(published.nodes, []);
  const conflicts = published.references.filter((ref) =>
    ref.reason?.includes("Ambiguous pinned versions"),
  );
  assert.ok(conflicts.length > 0);
  const before = [...fs.files];
  const value = await assembleAgentContext(fs, root, { kind: "card", cardId: conflicted.cardId });
  assert.ok(
    section(value, "unknown").items.some((item) =>
      item.why.includes("Ambiguous pinned versions for node-target"),
    ),
    JSON.stringify(section(value, "unknown")),
  );
  assert.equal(conflicts.length, 2);
  assert.ok(conflicts.every((ref) => ref.targetNodeId === "node-target" && !ref.nodeId));
  const rows = section(value, "references").items.filter((item) => item.nodeId === "node-target");
  assert.deepEqual(
    rows.map((item) => item.version?.commit),
    [first, second],
  );
  assert.deepEqual(
    rows.map((item) => item.text),
    ["## Exact\nFirst pinned rule.", "## Exact\nSecond pinned rule."],
  );
  assert.ok(!section(value, "unknown").items.some((item) => /node-nope00|Missing/.test(item.why)));
  const positive = await readCardBodyReferences(fs, single.cardId);
  assert.deepEqual(positive.nodes, []);
  assert.equal(
    positive.references.filter(
      (ref) =>
        ref.nodeId === "node-target" && ref.heading === "Exact" && ref.version?.commit === first,
    ).length,
    2,
  );
  const positiveValue = await assembleAgentContext(fs, root, {
    kind: "card",
    cardId: single.cardId,
  });
  assert.ok(
    !section(positiveValue, "unknown").items.some((item) =>
      /node-nope00|Missing|Ambiguous pinned versions/.test(item.why),
    ),
  );
  const checked = await checkGraph(fs, root, async () => true);
  assert.ok(
    checked.issues.some(
      (issue) =>
        issue.kind === "unresolved-link" &&
        issue.path === conflicted.path &&
        issue.target === "node-target#Exact" &&
        issue.reason.includes("Ambiguous pinned versions"),
    ),
  );
  assert.ok(
    !checked.issues.some(
      (issue) =>
        issue.kind === "unresolved-link" &&
        issue.path === single.path &&
        issue.target === "node-target#Exact",
    ),
  );
  assert.deepEqual([...fs.files], before);
});

test("canonical source binding precedes a same-name alias while true paths and unbound links keep their meaning", async () => {
  const { fs, node, save } = await fixture();
  await node("Original", "node-target", "prompt", "## Exact\nPinned original rule.");
  const first = await save();
  await node("Original", "node-target", "prompt", "## Exact\nSecond pinned rule.");
  const second = await save();
  await fs.remove("Original");
  await fs.history.captureUnlocked([{ path: "Original/Original.md", raw: null }], {
    operation: "test.delete-before-alias",
  });
  await node("node-target", "node-imposter", "prompt", "## Exact\nAlias occupant rule.");
  await save();
  const prompt =
    "Bare node-target「Exact」 and [canonical](node-target#Exact); [actual path](../node-target/node-target.md#Exact).";
  const source = (commit: string) => ({
    resource: "../Original/Original.md",
    version: { commit, path: "Original/Original.md" },
  });
  const single = await createCardDocument(fs, {
    cardId: "card-boundalias",
    prompt,
    sources: [source(first)],
  });
  const dual = await createCardDocument(fs, {
    cardId: "card-conflictalias",
    prompt,
    sources: [source(first), source(second)],
  });
  const unbound = await createCardDocument(fs, {
    cardId: "card-unboundalias",
    prompt: "[ordinary alias](node-target#Exact)",
    sources: [],
  });
  const before = [...fs.files];
  const published = await readCardBodyReferences(fs, single.cardId);
  assert.equal(published.card.body, prompt);
  assert.deepEqual(
    published.nodes.map((item) => ({ nodeId: item.nodeId, name: item.name, path: item.path })),
    [{ nodeId: "node-imposter", name: "node-target", path: "node-target" }],
  );
  const bare = published.references.find((ref) => ref.kind === "mention")!;
  assert.equal(bare.nodeId, "node-target");
  assert.deepEqual(bare.version, source(first).version);
  const value = await assembleAgentContext(fs, root, { kind: "card", cardId: single.cardId });
  const canonical = section(value, "decisions").items.find(
    (item) => item.why.includes("link: node-target#Exact") && item.heading === "Exact",
  );
  assert.ok(canonical, JSON.stringify(section(value, "decisions")));
  assert.equal(canonical.nodeId, "node-target", JSON.stringify(section(value, "decisions")));
  assert.equal(canonical.text, "Pinned original rule.");
  assert.deepEqual(canonical.version, source(first).version);
  const markdown = published.references.find((ref) => ref.raw === "node-target#Exact")!;
  assert.equal(markdown.nodeId, bare.nodeId);
  assert.deepEqual(markdown.version, bare.version);
  const pathRef = published.references.find(
    (ref) => ref.raw === "../node-target/node-target.md#Exact",
  )!;
  assert.equal(pathRef.nodeId, "node-imposter");
  assert.equal(pathRef.version?.path, "node-target/node-target.md");
  assert.ok(
    section(value, "decisions").items.some(
      (item) =>
        item.nodeId === "node-imposter" &&
        item.why.includes("link: ../node-target/node-target.md#Exact") &&
        item.text === "Alias occupant rule.",
    ),
  );
  const unboundRefs = await readCardBodyReferences(fs, unbound.cardId);
  assert.equal(unboundRefs.references[0]?.nodeId, "node-imposter");
  assert.equal(unboundRefs.references[0]?.version?.path, "node-target/node-target.md");
  const conflicted = await readCardBodyReferences(fs, dual.cardId);
  for (const ref of conflicted.references.filter(
    (ref) => ref.raw === "node-target" || ref.raw === "node-target#Exact",
  )) {
    assert.equal(ref.nodeId, undefined);
    assert.equal(ref.targetNodeId, "node-target");
    assert.match(ref.reason!, /Ambiguous pinned versions/);
  }
  const dualValue = await assembleAgentContext(fs, root, { kind: "card", cardId: dual.cardId });
  assert.ok(
    section(dualValue, "unknown").items.some((item) =>
      item.why.includes("Ambiguous pinned versions"),
    ),
  );
  assert.ok(
    !section(dualValue, "decisions").items.some((item) =>
      item.why.includes("link: node-target#Exact"),
    ),
  );
  assert.deepEqual(
    section(dualValue, "references")
      .items.filter((item) => item.nodeId === "node-target")
      .map((item) => item.version?.commit),
    [first, second],
  );
  assert.equal(conflicted.card.body, prompt);
  assert.deepEqual([...fs.files], before);
});

test("authored relative and root paths remain paths beside a canonical source binding", async () => {
  const { fs, node, save } = await fixture();
  await node("Original", "node-target", "prompt", "## Exact\nPinned original rule.");
  const pin = { commit: await save(), path: "Original/Original.md" };
  await fs.remove("Original");
  await fs.history.captureUnlocked([{ path: pin.path, raw: null }], {
    operation: "test.delete-before-path-reuse",
  });
  await node("node-target", "node-imposter", "prompt", "## Exact\nCurrent directory rule.");
  await save();
  const cases = [
    ["canonical", "node-target#Exact", "node-target"],
    ["relative", "../node-target#Exact", "node-imposter"],
    ["root", "/node-target#Exact", "node-imposter"],
    ["dot-relative", "./../node-target#Exact", "node-imposter"],
    ["full-note", "../node-target/node-target.md#Exact", "node-imposter"],
    ["note", "node-target.md#Exact", "node-imposter"],
  ] as const;
  const prompt = cases.map(([label, destination]) => `[${label}](${destination})`).join("\n");
  const card = await createCardDocument(fs, {
    cardId: "card-pathsyntax",
    prompt,
    sources: [{ resource: "../Original/Original.md", version: pin }],
  });
  const before = [...fs.files];
  const published = await readCardBodyReferences(fs, card.cardId);
  assert.equal(published.card.body, prompt);
  const value = await assembleAgentContext(fs, root, { kind: "card", cardId: card.cardId });
  for (const [label, destination, nodeId] of cases) {
    const ref = published.references.find((item) => item.raw === destination);
    assert.ok(ref, label);
    assert.equal(
      ref.nodeId,
      nodeId,
      JSON.stringify({ label, ref, decisions: section(value, "decisions") }),
    );
    assert.equal(ref.heading, "Exact");
    if (label === "canonical") assert.deepEqual(ref.version, pin);
    else assert.equal(ref.version?.path, "node-target/node-target.md");
    assert.ok(
      section(value, "decisions").items.some(
        (item) =>
          item.nodeId === nodeId &&
          item.why.includes(`link: ${destination}`) &&
          item.text ===
            (label === "canonical" ? "Pinned original rule." : "Current directory rule."),
      ),
      label,
    );
  }
  assert.deepEqual([...fs.files], before);
});

test("decisions sections: adjacent quoted titles bind exact pins; outgoing follows the section and incoming the whole Node", async () => {
  const { fs, node, save, card } = await fixture();
  await node(
    "Task",
    "node-task",
    "goal",
    "Intro node-before.\n## Chosen\nOld chosen node-inside.\n## Other\nnode-outside.",
  );
  for (const name of ["before", "inside", "outside"])
    await node(name, `node-${name}`, "prompt", `${name} fact.`);
  await node("Incoming", "node-incoming", "prompt", "See node-task.");
  const basis = await save();
  await node("Task", "node-task", "goal", "## Chosen\nNew changed text.\n## Only Today\nnew");
  await card(
    "card-selection",
    "node-task「Chosen」 and node-task「Only Today」.\n```text\nnode-task「Other」\n```",
    [{ resource: "../Task/Task.md#Chosen", version: { commit: basis, path: "Task/Task.md" } }],
  );
  await save();
  const value = await assembleAgentContext(fs, root, { kind: "card", cardId: "card-selection" });
  const decisions = section(value, "decisions").items;
  assert.ok(
    decisions.some(
      (item) =>
        item.nodeId === "node-task" &&
        item.heading === "Chosen" &&
        item.text?.includes("Old chosen"),
    ),
  );
  assert.ok(decisions.some((item) => item.nodeId === "node-inside"));
  assert.ok(decisions.some((item) => item.nodeId === "node-incoming"));
  assert.ok(
    !decisions.some((item) => item.nodeId === "node-before" || item.nodeId === "node-outside"),
  );
  assert.ok(section(value, "unknown").items.some((item) => item.why.includes("Only Today")));
});
test("decisions brief: retained Node times and unfinished Cards are current facts, not a previous session", async () => {
  const { fs, node, save, card } = await fixture();
  await node("Old", "node-older", "goal", "older");
  await save();
  await node("New", "node-newer", "goal", "newer");
  await card("card-wait", "Waiting");
  await save();
  const value = await assembleAgentContext(fs, root, { kind: "brief" });
  assert.deepEqual(
    section(value, "references").items.map((item) => item.nodeId),
    ["node-newer", "node-older"],
  );
  assert.ok(
    section(value, "references").items.every(
      (item) => typeof (item as { at?: string }).at === "string",
    ),
  );
  assert.ok(section(value, "open").items.some((item) => item.cardId === "card-wait"));
  assert.equal(section(value, "paths").items.length, 0);
  assert.equal(section(value, "rules").items.length, 0);
});

test("decisions protected boundary: five individually bounded source texts exceed one page before optional sections", async () => {
  const { fs, node, save, card } = await fixture();
  for (let index = 0; index < 5; index++)
    await node(`Source${index}`, `node-source${index}`, "goal", "汉".repeat(1600));
  const basis = await save();
  await card(
    "card-many",
    "Read sources. Missing node-absent「Missing」.",
    Array.from({ length: 5 }, (_, index) => ({
      resource: `../Source${index}/Source${index}.md`,
      version: { commit: basis, path: `Source${index}/Source${index}.md` },
    })),
  );
  await save();
  const value = await assembleAgentContext(
    fs,
    root,
    { kind: "card", cardId: "card-many" },
    { repository: { trackedFiles: [], sources: { files: [], errors: [] } } },
  );
  const protectedSections = value.sections.filter(
    (section) => section.kind === "references" || section.kind === "unknown",
  );
  const bytes = Buffer.byteLength(JSON.stringify(protectedSections));
  assert.ok(bytes > 16384);
  assert.ok(
    section(value, "references").items.every((item) => Array.from(item.text ?? "").length <= 1600),
  );
  await nativeFs.mkdir(path.resolve(".scratch/decisions-cli"), { recursive: true });
  await nativeFs.writeFile(
    path.resolve(".scratch/decisions-cli/protected-result.json"),
    JSON.stringify(value) + "\n",
  );
  process.stdout.write(
    JSON.stringify({
      protectedBytes: bytes,
      pageLimit: 16384,
      sourceCount: 5,
      referenceItems: section(value, "references").items.length,
      unknownItems: section(value, "unknown").items.length,
      perSourceCharacters: 1600,
    }) + "\n",
  );
});

test("decisions controls: missing, repeated and ambiguous literal titles stay unknown; prose descriptions never become selectors", async () => {
  const { fs, node, save, card } = await fixture();
  await node("Target", "node-target", "goal", "## Repeat\none\n## Repeat\ntwo\n## Unique\nfirst");
  const first = await save();
  await node("Target", "node-target", "goal", "## Unique\nsecond");
  const second = await save();
  const pin = (commit: string) => ({
    resource: "../Target/Target.md",
    version: { commit, path: "Target/Target.md" },
  });
  await card("card-literals", "node-target「Repeat」 node-target「Missing」 node-target「」", [
    pin(first),
  ]);
  await card("card-ambiguity", "node-target「Unique」", [pin(first), pin(second)]);
  await card("card-prose", "来源 Node「Unique」中的政策表格。", [pin(first)]);
  await save();
  const missing = await assembleAgentContext(fs, root, { kind: "card", cardId: "card-literals" });
  assert.ok(!section(missing, "decisions").items.some((item) => item.nodeId === "node-target"));
  assert.ok(section(missing, "unknown").items.some((item) => item.why.includes("duplicated")));
  assert.ok(section(missing, "unknown").items.some((item) => item.why.includes("Missing")));
  const ambiguous = await assembleAgentContext(fs, root, {
    kind: "card",
    cardId: "card-ambiguity",
  });
  assert.ok(
    section(ambiguous, "unknown").items.some((item) => item.why.includes("Ambiguous pinned")),
  );
  const prose = await assembleAgentContext(fs, root, { kind: "card", cardId: "card-prose" });
  assert.ok(
    section(prose, "references").items.some(
      (item) => item.nodeId === "node-target" && !item.heading && item.text?.includes("one"),
    ),
  );
  assert.ok(!section(prose, "decisions").items.some((item) => item.nodeId === "node-target"));
});
test("decisions Node body: inline exact citations and file references remain readable without expanding task files", async () => {
  const { fs, node } = await fixture();
  await node(
    "Task",
    "node-task",
    "goal",
    "See node-rule「Late」 and src/b.ts.\n```\nnode-ignored\n```",
    { resource: "../../src/a.ts" },
  );
  await node(
    "Rule",
    "node-rule",
    "prompt",
    "Intro.\n## Late\nExact selected rule.\n## End\nOther.",
  );
  await node("Ignored", "node-ignored", "prompt", "Ignored.");
  const value = await assembleAgentContext(
    fs,
    root,
    { kind: "node", nodeId: "node-task" },
    { repository: repo },
  );
  assert.deepEqual(
    section(value, "tests").items.map((item) => item.path),
    ["test/a.test.ts"],
  );
  assert.ok(
    section(value, "decisions").items.some(
      (item) =>
        item.nodeId === "node-rule" &&
        item.heading === "Late" &&
        item.text?.includes("Exact selected rule"),
    ),
  );
  assert.ok(section(value, "decisions").items.some((item) => item.path === "src/b.ts"));
  assert.ok(!section(value, "decisions").items.some((item) => item.nodeId === "node-ignored"));
});

test("decisions missing pin: unavailable history cannot fall back to the publication body", async () => {
  const { fs, node, save, card } = await fixture();
  await node("Target", "node-target", "goal", "## Exact\nPublication text.");
  await save();
  await card("card-missing", "node-target「Exact」", [
    {
      resource: "../Target/Target.md",
      version: { commit: "f".repeat(64), path: "Target/Target.md" },
    },
  ]);
  await save();
  const value = await assembleAgentContext(fs, root, { kind: "card", cardId: "card-missing" });
  assert.ok(!section(value, "decisions").items.some((item) => item.nodeId === "node-target"));
  assert.ok(section(value, "unknown").items.some((item) => item.why.includes("Missing history")));
  const basis = await save();
  await card("card-directory", "node-target「Exact」", [
    { resource: "../Target/Target.md", version: { commit: basis, path: "Target/Target.md" } },
  ]);
  await save();
  const directory = fs.history.readDirectory.bind(fs.history);
  fs.history.readDirectory = async (commit, folder) =>
    commit === basis ? new Map() : directory(commit, folder);
  const unavailable = await assembleAgentContext(fs, root, {
    kind: "card",
    cardId: "card-directory",
  });
  assert.ok(!section(unavailable, "decisions").items.some((item) => item.nodeId === "node-target"));
  assert.ok(
    section(unavailable, "unknown").items.some((item) =>
      item.why.includes("unique historical Node"),
    ),
  );
});

test("decisions pagination: recent facts retain chronology, Unicode excerpts and revision-bound continuation", async () => {
  const { fs, node, save } = await fixture();
  for (let index = 0; index < 11; index++) {
    await node(`Goal${index}`, `node-goal${index}`, "goal", "😀".repeat(1599) + "\r\nTail");
    await save();
  }
  const first = await assembleAgentContext(fs, root, { kind: "brief" });
  const facts = section(first, "references");
  assert.equal(facts.total, 11);
  assert.equal(facts.omitted, 1);
  assert.equal(facts.items[0]?.nodeId, "node-goal10");
  const next = await assembleAgentContext(fs, root, { kind: "brief" }, facts.next);
  assert.deepEqual(
    section(next, "references").items.map((item) => item.nodeId),
    ["node-goal0"],
  );
  const read = await assembleAgentContext(fs, root, { kind: "node", nodeId: "node-goal0" });
  assert.equal(section(read, "references").items[0]?.text, "😀".repeat(1599));
  await node("Goal0", "node-goal0", "goal", "Changed");
  await save();
  await assert.rejects(
    assembleAgentContext(fs, root, { kind: "brief" }, facts.next),
    /source changed/,
  );
});

test("decisions Card selector: exact body selectors narrow an existing source at its pin without a source fragment", async () => {
  const { fs, node, save, card } = await fixture();
  await node(
    "Task",
    "node-task",
    "goal",
    "A".repeat(1700) + " node-before.\n## Late\nOld late node-inside.\n## Other\nnode-outside.",
  );
  for (const name of ["before", "inside", "outside"])
    await node(name, `node-${name}`, "prompt", `${name} fact.`);
  const basis = await save();
  await node("Task", "node-task", "goal", "## No Such\nToday-only policy.");
  const source = { resource: "../Task/Task.md", version: { commit: basis, path: "Task/Task.md" } };
  await card("card-late", "Read node-task「Late」.", [source]);
  await card("card-missing", "Read node-task「No Such」.", [source]);
  await save();
  const repository = { trackedFiles: [], sources: { files: [], errors: [] } };
  const selected = await assembleAgentContext(
    fs,
    root,
    { kind: "card", cardId: "card-late" },
    { repository },
  );
  const original = section(selected, "references").items.find(
    (item) => item.nodeId === "node-task",
  )!;
  assert.equal(original.heading, "Late");
  assert.equal(original.version?.commit, basis);
  assert.match(original.text!, /^## Late/);
  assert.ok(section(selected, "decisions").items.some((item) => item.nodeId === "node-inside"));
  assert.ok(
    !section(selected, "decisions").items.some(
      (item) => item.nodeId === "node-before" || item.nodeId === "node-outside",
    ),
  );
  const missing = await assembleAgentContext(
    fs,
    root,
    { kind: "card", cardId: "card-missing" },
    { repository },
  );
  const fallback = section(missing, "references").items.find(
    (item) => item.nodeId === "node-task",
  )!;
  assert.equal(fallback.version?.commit, basis);
  assert.equal(fallback.heading, undefined);
  assert.equal(fallback.text, "A".repeat(1600));
  assert.ok(
    section(missing, "unknown").items.some(
      (item) => item.why.includes("No Such") && item.version?.commit === basis,
    ),
  );
});

test("source section failures retain the pinned opening, task materials and outgoing evidence", async () => {
  const { fs, node, save, card } = await fixture();
  const pinnedBody = "Old opening node-before.\n## Repeat\nfirst\n## Repeat\nsecond\n## Late\nold";
  await node("Task", "node-task", "goal", pinnedBody, { resource: "../../src/a.ts" });
  await node("Before", "node-before", "prompt", "Before fact.");
  const pin = await save();
  await node("Task", "node-task", "goal", "Today opening.\n## Missing\nToday only.");
  for (const heading of ["Missing", "Repeat"])
    await card(`card-${heading.toLowerCase()}`, "Read the source.", [
      {
        resource: `../Task/Task.md#${heading}`,
        version: { commit: pin, path: "Task/Task.md" },
      },
    ]);
  await card("card-legacy", "Legacy source.", [{ resource: "../Task/Task.md#Absent" }]);
  await save();
  for (const id of ["card-missing", "card-repeat"]) {
    const value = await assembleAgentContext(
      fs,
      root,
      { kind: "card", cardId: id },
      { repository: repo },
    );
    const source = section(value, "references").items.find((item) => item.nodeId === "node-task")!;
    assert.equal(source.text, pinnedBody);
    assert.equal(source.version?.commit, pin);
    assert.equal(source.heading, undefined);
    assert.ok(
      section(value, "unknown").items.some(
        (item) => item.nodeId === "node-task" && /section/.test(item.why),
      ),
    );
    assert.ok(section(value, "decisions").items.some((item) => item.nodeId === "node-before"));
    assert.deepEqual(
      section(value, "tests").items.map((item) => item.path),
      ["test/a.test.ts"],
    );
    assert.ok(!JSON.stringify(section(value, "references")).includes("Today"));
  }
  const legacy = await assembleAgentContext(fs, root, { kind: "card", cardId: "card-legacy" });
  assert.match(
    section(legacy, "references").items.find((item) => item.nodeId === "node-task")!.text!,
    /^Today opening/,
  );
  assert.ok(section(legacy, "unknown").items.some((item) => /Absent/.test(item.why)));
});

test("competing literal source selectors keep the source whole and retain their uncertainty", async () => {
  const { fs, node, save, card } = await fixture();
  const body = "Opening.\n## First\none\n## Second\ntwo";
  await node("Task", "node-task", "goal", body);
  const pin = await save();
  await card("card-competing", "node-task「First」 and node-task「Second」", [
    {
      resource: "../Task/Task.md",
      version: { commit: pin, path: "Task/Task.md" },
    },
  ]);
  await save();
  const value = await assembleAgentContext(fs, root, { kind: "card", cardId: "card-competing" });
  assert.equal(
    section(value, "references").items.find((item) => item.nodeId === "node-task")!.text,
    body,
  );
  assert.ok(section(value, "unknown").items.some((item) => /Ambiguous literal/.test(item.why)));
});

test("one shared ancestor occupies one list place and combines both source reasons deterministically", async () => {
  const { fs, node, save, card } = await fixture();
  await node("Project", "node-project", "goal", "Shared rule.");
  const names = Array.from({ length: 12 }, (_, index) => String.fromCharCode(97 + index));
  for (const name of names) await node(`Project/${name}`, `node-${name}`, "goal", `${name} task.`);
  const pin = await save();
  await card(
    "card-shared",
    "Shared sources.",
    names.map((name) => ({
      resource: `../Project/${name}/${name}.md`,
      version: { commit: pin, path: `Project/${name}/${name}.md` },
    })),
  );
  await save();
  const start = { kind: "card", cardId: "card-shared" } as const;
  const value = await assembleAgentContext(fs, root, start);
  const rules = section(value, "rules");
  assert.equal(rules.total, 1);
  assert.equal(rules.items[0]!.nodeId, "node-project");
  assert.match(rules.items[0]!.why, /node-a/);
  assert.match(rules.items[0]!.why, /node-b/);
  assert.match(rules.items[0]!.why, /node-l/);
  assert.equal(section(value, "references").total, 13);
  assert.equal(section(value, "references").items.length, 10);
  assert.deepEqual(await assembleAgentContext(fs, root, start), value);
  const page = projectAgentContext(
    value,
    root,
    { text: "Shared sources.", bytes: 15 },
    (page) => Buffer.byteLength(JSON.stringify(page)) + 1,
  );
  const displayedRules = page.sections.find((section) => section.kind === "rules")!.items;
  assert.equal(displayedRules.length, 1);
  assert.equal(displayedRules[0]!.truncated, true);
  assert.ok(
    page.sections.every(
      (section) =>
        section.items.length <= 10 &&
        section.items.every((item) => Array.from(item.why ?? "").length <= 120),
    ),
  );
  assert.ok(Buffer.byteLength(JSON.stringify(page)) + 1 <= 16384);
});

test("source deduplication keeps different pinned versions and literal sections separately identifiable", async () => {
  const { fs, node, save, card } = await fixture();
  await node(
    "Task",
    "node-task",
    "goal",
    "Old opening.\n## First\nOld first.\n## Second\nOld second.",
  );
  const old = await save();
  await node(
    "Task",
    "node-task",
    "goal",
    "New opening.\n## First\nNew first.\n## Second\nNew second.",
  );
  const current = await save();
  await card(
    "card-versions",
    "Explicit source choices.",
    [
      { commit: old, heading: "First" },
      { commit: current, heading: "First" },
      { commit: current, heading: "Second" },
      { commit: current, heading: undefined },
      { commit: current, heading: "First" },
    ].map(({ commit, heading }) => ({
      resource: `../Task/Task.md${heading ? `#${heading}` : ""}`,
      version: { commit, path: "Task/Task.md" },
    })),
  );
  await save();
  const value = await assembleAgentContext(fs, root, { kind: "card", cardId: "card-versions" });
  const sources = section(value, "references").items.filter((item) => item.nodeId === "node-task");
  assert.deepEqual(
    sources.map((item) => [item.version?.commit, item.heading]),
    [
      [old, "First"],
      [current, "First"],
      [current, "Second"],
      [current, undefined],
    ],
  );
  assert.match(sources[0]!.text!, /Old first/);
  assert.match(sources[1]!.text!, /New first/);
  assert.match(sources[2]!.text!, /New second/);
  assert.match(sources[3]!.text!, /^New opening/);
});
