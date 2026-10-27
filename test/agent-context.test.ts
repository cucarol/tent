import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { PropagationMemoryFs } from "./propagation-memory.js";
import { serializeFrontmatter } from "../src/core/base/frontmatter.js";
import { scaffoldTent } from "../src/core/store/scaffold.js";
import {
  assembleAgentContext,
  type AgentContext,
  type AgentContextRepository,
} from "../src/core/read/agent-context.js";
import {
  readCardBodyReferences,
  resolveBodyNodeReferences,
} from "../src/core/read/card-references.js";
import { checkGraph } from "../src/core/check/graph-check.js";

const root = path.resolve(".scratch/agent-context-memory");
const file = (folder: string) => `${folder}/${path.posix.basename(folder)}.md`;
const section = (context: AgentContext, kind: AgentContext["sections"][number]["kind"]) =>
  context.sections.find((section) => section.kind === kind)!;
const repository: AgentContextRepository = {
  trackedFiles: ["src/a.ts", "src/index.ts", "test/a.test.ts", "test/looks-related.test.ts"],
  sources: {
    errors: [],
    files: [
      { path: "src/a.ts", content: "export function A() {}" },
      { path: "src/index.ts", content: 'export { A } from "./a";' },
      { path: "test/a.test.ts", content: 'import { A } from "../src/index"; A();' },
      { path: "test/looks-related.test.ts", content: "// a.ts has no import here" },
    ],
  },
};

async function fixture() {
  const fs = new PropagationMemoryFs();
  await scaffoldTent(fs, { name: "Context" });
  const snapshots = new Map<string, Map<string, string>>();
  // Extend the storage fixture's directory projection; the production adapter already supports root reads.
  const capture = fs.history.captureUnlocked.bind(fs.history);
  fs.history.captureUnlocked = async (...args) => {
    const result = await capture(...args);
    if (result.commit) snapshots.set(result.commit, new Map(fs.files));
    return result;
  };
  fs.history.readDirectory = async (commit, directory) => {
    const snapshot = snapshots.get(commit);
    if (!snapshot) throw new Error("Missing snapshot");
    return new Map(
      [...snapshot].filter(([file]) => directory === undefined || file.startsWith(directory + "/")),
    );
  };
  fs.history.completedCardPaths = async () => new Set();
  fs.history.changedRetainedDocuments = async () => [];
  fs.history.diff = async (from, to) =>
    `--- ${from.path}\n+++ ${to.path}\n@@ -1 +1 @@\n-old\n+new\n`;
  const node = async (folder: string, id: string, type: string, body: string, fields = {}) =>
    fs.writeFile(file(folder), serializeFrontmatter({ id, type, ...fields }, body));
  const save = async () => {
    const result = await fs.history.captureUnlocked(
      [...fs.files].map(([path, raw]) => ({ path, raw })),
      { operation: "test.capture" },
    );
    return result.commit!;
  };
  return { fs, node, save };
}

test("node and file starts assemble direct rules, real re-export test evidence, decisions and open goals deterministically", async () => {
  const { fs, node } = await fixture();
  await node("Module", "node-module", "goal", "Module invariant.", {
    sources: [{ resource: "../../src/", track: "structure" }],
  });
  await node("Module/Rule", "node-rulelong", "prompt", "Use values only. Do not infer coverage.");
  await node("Module/Task", "node-tasklong", "goal", "Implement A. See node-rejectedlong.", {
    resource: "../../../src/a.ts",
  });
  await node(
    "Rejected",
    "node-rejectedlong",
    "prompt",
    "Abandoned option: do not copy the entire export set. See node-tasklong.",
    { status: "deprecated" },
  );
  const before = [...fs.files];
  const first = await assembleAgentContext(
    fs,
    root,
    { kind: "node", nodeId: "node-tasklong" },
    { repository },
  );
  assert.deepEqual(
    await assembleAgentContext(fs, root, { kind: "node", nodeId: "node-tasklong" }, { repository }),
    first,
  );
  assert.deepEqual([...fs.files], before);
  assert.deepEqual(
    first.sections.map((section) => section.kind),
    ["references", "rules", "paths", "tests", "changes", "decisions", "open", "unknown"],
  );
  assert.ok(section(first, "rules").items.some((item) => item.nodeId === "node-rulelong"));
  assert.deepEqual(
    section(first, "tests").items.map((item) => item.path),
    ["test/a.test.ts"],
  );
  assert.ok(
    section(first, "decisions").items.some(
      (item) => item.nodeId === "node-rejectedlong" && item.text?.startsWith("Abandoned option"),
    ),
  );
  assert.ok(section(first, "open").items.some((item) => item.nodeId === "node-tasklong"));
  assert.ok(first.sections.every((section) => section.items.every((item) => item.why)));
  const byFile = await assembleAgentContext(
    fs,
    root,
    { kind: "resource", resource: "../src/a.ts" },
    { repository },
  );
  assert.ok(section(byFile, "references").items.some((item) => item.nodeId === "node-tasklong"));
  assert.ok(section(byFile, "rules").items.some((item) => item.nodeId === "node-rulelong"));
});

test("Card references preserve publication identity, exact old section and current path after move/path reuse", async () => {
  const { fs, node, save } = await fixture();
  await node(
    "Old",
    "node-original",
    "goal",
    "before\n## Keep\nold section\n## Other\nnever include",
    { resource: "../../src/a.ts" },
  );
  const basis = await save();
  const body = "Do [the section](../Old/Old.md#Keep), use node-original and src/a.ts.";
  const card = "cards/card-request.md";
  await fs.writeFile(
    card,
    serializeFrontmatter(
      {
        id: "card-request",
        type: "card",
        schemaVersion: 3,
        state: "pending",
        sources: [
          { resource: "../Old/Old.md#Keep", version: { commit: basis, path: "Old/Old.md" } },
        ],
      },
      body,
    ),
  );
  const publication = await save();
  const cardBytes = fs.files.get(card);
  await fs.move("Old", "Moved");
  await fs.move("Moved/Old.md", "Moved/Moved.md");
  await node("Moved", "node-original", "goal", "## Keep\nnew section\n", {
    resource: "../../src/a.ts",
  });
  await node("Old", "node-replacement", "goal", "## Keep\nwrong replacement\n");
  await save();
  const references = await readCardBodyReferences(fs, "card-request");
  assert.equal(references.publication.commit, publication);
  assert.ok(references.references.every((ref) => ref.nodeId === "node-original"));
  const result = await assembleAgentContext(
    fs,
    root,
    { kind: "card", cardId: "card-request" },
    { repository },
  );
  const texts = section(result, "references")
    .items.filter((item) => item.heading === "Keep")
    .map((item) => item.text);
  assert.ok(texts.length >= 1);
  assert.ok(texts.every((text) => text === "## Keep\nold section\n"));
  assert.ok(
    section(result, "decisions").items.some(
      (item) => item.nodeId === "node-original" && item.path === ".tent/Moved/Moved.md",
    ),
  );
  assert.ok(!JSON.stringify(result).includes("wrong replacement"));
  assert.ok(section(result, "changes").items.some((item) => item.text?.includes("-old\n+new")));
  assert.equal(fs.files.get(card), cardBytes);
  const checked = await checkGraph(fs, root, async () => false);
  assert.ok(
    !checked.issues.some((issue) => issue.kind === "unresolved-link" && issue.path === card),
    JSON.stringify(checked),
  );
  await fs.remove("Moved");
  const missing = await assembleAgentContext(
    fs,
    root,
    { kind: "card", cardId: "card-request" },
    { repository },
  );
  assert.ok(
    section(missing, "unknown").items.some((item) =>
      item.why.includes("node-original has no current path"),
    ),
  );
  assert.ok(
    !section(missing, "decisions").items.some((item) => item.nodeId === "node-replacement"),
  );
});

test("a broken publication link remains broken even when today's same path now exists", async () => {
  const { fs, node, save } = await fixture();
  const card = "cards/card-broken.md";
  await fs.writeFile(
    card,
    serializeFrontmatter(
      { id: "card-broken", type: "card", schemaVersion: 3, state: "pending", sources: [] },
      "Read [missing](../Missing/Missing.md#Rule).",
    ),
  );
  await save();
  await node("Missing", "node-later", "prompt", "## Rule\nNew identity.");
  await save();
  const references = await readCardBodyReferences(fs, "card-broken");
  assert.equal(references.references[0]?.nodeId, undefined);
  const checked = await checkGraph(fs, root, async () => true);
  assert.ok(
    checked.issues.some((issue) => issue.kind === "unresolved-link" && issue.path === card),
  );
  const context = await assembleAgentContext(
    fs,
    root,
    { kind: "card", cardId: "card-broken" },
    { repository },
  );
  assert.ok(!section(context, "references").items.some((item) => item.nodeId === "node-later"));
  assert.ok(section(context, "unknown").items.some((item) => item.why.includes("did not resolve")));
});

test("historical Node reads never substitute current identity, path, section or repository tests", async () => {
  const { fs, node, save } = await fixture();
  await node("Old", "node-original", "goal", "old only", { resource: "../../src/a.ts" });
  const commit = await save();
  await node("Old", "node-replacement", "goal", "new only");
  const context = await assembleAgentContext(
    fs,
    root,
    { kind: "node", nodeId: "node-original", version: { commit, path: "Old/Old.md" } },
    {
      repository: () => {
        throw new Error("Must not read current repository");
      },
    },
  );
  assert.equal(section(context, "references").items[0]?.text, "old only");
  assert.equal(section(context, "tests").items.length, 0);
  assert.ok(!JSON.stringify(context).includes("new only"));
  const read = fs.readFile.bind(fs);
  fs.readFile = async (file) => {
    if (file === "index.md" || file === "Old/Old.md")
      throw new Error("Historical context must not load live Nodes");
    return read(file);
  };
  assert.equal(
    section(
      await assembleAgentContext(fs, root, {
        kind: "node",
        nodeId: "node-original",
        version: { commit, path: "Old/Old.md" },
      }),
      "references",
    ).items[0]?.text,
    "old only",
  );
  await assert.rejects(
    assembleAgentContext(fs, root, {
      kind: "node",
      nodeId: "node-replacement",
      version: { commit, path: "Old/Old.md" },
    }),
    /identity\/path/,
  );
});

test("only Cards related through verified published sources are listed, and reads do not confirm or capture", async () => {
  const { fs, node, save } = await fixture();
  await node("Goal", "node-goal", "goal", "Deliver a value.", { resource: "../../src/a.ts" });
  const basis = await save();
  for (const [id, sources] of [
    [
      "card-related",
      [{ resource: "../Goal/Goal.md", version: { commit: basis, path: "Goal/Goal.md" } }],
    ],
    ["card-other", []],
  ] as const)
    await fs.writeFile(
      `cards/${id}.md`,
      serializeFrontmatter(
        { id, type: "card", schemaVersion: 3, state: "pending", sources },
        "Implement request.",
      ),
    );
  await save();
  fs.history.captureUnlocked = async () => {
    throw new Error("Read attempted capture");
  };
  fs.writeFile = async () => {
    throw new Error("Read attempted file write");
  };
  const first = await assembleAgentContext(
    fs,
    root,
    { kind: "node", nodeId: "node-goal" },
    { repository },
  );
  assert.deepEqual(
    section(first, "open")
      .items.filter((item) => item.cardId)
      .map((item) => item.cardId),
    ["card-related"],
  );
  const brief = await assembleAgentContext(fs, root, { kind: "brief" });
  assert.deepEqual(
    section(brief, "open").items.map((item) => item.cardId),
    ["card-other", "card-related"],
  );
  fs.files.set(
    "cards/card-related.md",
    fs.files.get("cards/card-related.md")! + "unretained body change",
  );
  const changed = await assembleAgentContext(
    fs,
    root,
    { kind: "node", nodeId: "node-goal" },
    { repository },
  );
  assert.ok(!section(changed, "open").items.some((item) => item.cardId === "card-related"));
  assert.ok(
    section(changed, "unknown").items.some((item) =>
      item.why.includes("Card card-related state is unknown"),
    ),
  );
});

test("historical duplicate identities and missing headings never inherit a current valid target", async () => {
  const { fs, node, save } = await fixture();
  await node("Old", "node-duplicate", "goal", "## Existing\nold");
  await fs.writeFile(
    "cards/card-missingheading.md",
    serializeFrontmatter(
      { id: "card-missingheading", type: "card", schemaVersion: 3, state: "pending", sources: [] },
      "Read [missing section](../Old/Old.md#Missing).",
    ),
  );
  await save();
  await node("Other", "node-duplicate", "goal", "## Missing\ncompeting");
  await fs.writeFile(
    "cards/card-ambiguous.md",
    serializeFrontmatter(
      { id: "card-ambiguous", type: "card", schemaVersion: 3, state: "pending", sources: [] },
      "Read [ambiguous](../Old/Old.md#Missing).",
    ),
  );
  await save();
  await fs.remove("Other");
  await node("Old", "node-duplicate", "goal", "## Missing\ncurrent");
  const refs = await readCardBodyReferences(fs, "card-ambiguous");
  assert.equal(refs.references[0]?.nodeId, undefined);
  const context = await assembleAgentContext(
    fs,
    root,
    { kind: "card", cardId: "card-ambiguous" },
    { repository },
  );
  assert.ok(!section(context, "references").items.some((item) => item.nodeId === "node-duplicate"));
  const missingHeading = await assembleAgentContext(
    fs,
    root,
    { kind: "card", cardId: "card-missingheading" },
    { repository },
  );
  assert.ok(
    section(missingHeading, "unknown").items.some((item) => item.why.includes("section not found")),
  );
  assert.ok(
    !section(missingHeading, "references").items.some((item) => item.heading === "Missing"),
  );
});

test("missing history, duplicate/missing sections and uncovered files produce explicit unknowns without current fallback", async () => {
  const { fs, node, save } = await fixture();
  await node("Old", "node-original", "goal", "## Rule\nfirst\n## Rule\nsecond");
  await fs.writeFile(
    "cards/card-duplicate.md",
    serializeFrontmatter(
      { id: "card-duplicate", type: "card", schemaVersion: 3, state: "pending", sources: [] },
      "Read [rule](../Old/Old.md#Rule).",
    ),
  );
  await save();
  const duplicated = await assembleAgentContext(
    fs,
    root,
    { kind: "card", cardId: "card-duplicate" },
    { repository },
  );
  assert.ok(section(duplicated, "unknown").items.some((item) => item.why.includes("duplicated")));
  const missing = await assembleAgentContext(
    fs,
    root,
    { kind: "card", cardId: "card-unpublished" },
    { repository },
  );
  assert.ok(
    section(missing, "unknown").items.some((item) =>
      item.why.includes("publication context unavailable"),
    ),
  );
  const uncovered = await assembleAgentContext(
    fs,
    root,
    { kind: "resource", resource: "../src/a.ts" },
    { repository },
  );
  assert.ok(
    section(uncovered, "unknown").items.some((item) => item.why === "No module covers src/a.ts"),
  );
});

test("every list has ten entries at most, continuation is real, excerpts retain original prefixes and brief cannot invent a session", async () => {
  const { fs, node } = await fixture();
  const files = Array.from({ length: 23 }, (_, i) => `src/f${String(i).padStart(2, "0")}.ts`);
  await node("Module", "node-module", "goal", "😀".repeat(2000), {
    sources: [{ resource: "../../src/", track: "structure" }],
  });
  const repo = {
    trackedFiles: files,
    sources: { files: files.map((path) => ({ path })), errors: [] },
  };
  const first = await assembleAgentContext(
    fs,
    root,
    { kind: "node", nodeId: "node-module" },
    { repository: repo },
  );
  assert.ok(first.sections.every((section) => section.items.length <= 10));
  assert.equal(section(first, "paths").total, 23);
  assert.equal(section(first, "paths").omitted, 13);
  assert.deepEqual(section(first, "paths").next, { offset: 10, expectedRevision: first.revision });
  await assert.rejects(
    assembleAgentContext(fs, root, first.start, { repository: repo, offset: 10 }),
    /requires expectedRevision/,
  );
  const next = await assembleAgentContext(fs, root, first.start, {
    repository: repo,
    ...section(first, "paths").next,
  });
  assert.equal(next.revision, first.revision);
  assert.equal(section(next, "paths").items.length, 10);
  assert.equal(section(next, "paths").omitted, 3);
  await assert.rejects(
    assembleAgentContext(fs, root, first.start, {
      repository: repo,
      offset: 10,
      expectedRevision: "different",
    }),
    /source changed/,
  );
  await node("Module", "node-module", "goal", "changed source", {
    sources: [{ resource: "../../src/", track: "structure" }],
  });
  await assert.rejects(
    assembleAgentContext(fs, root, first.start, {
      repository: repo,
      ...section(first, "paths").next,
    }),
    /source changed/,
  );
  assert.equal(section(first, "references").items[0]?.truncated, true);
  assert.equal(section(first, "references").items[0]?.text, "😀".repeat(1600));
  const before = [...fs.files];
  const brief = await assembleAgentContext(fs, root, { kind: "brief" });
  assert.match(
    section(brief, "unknown").items[0]!.why,
    /Session ownership is unavailable.*current facts only/,
  );
  assert.equal(section(brief, "changes").items.length, 0);
  assert.deepEqual([...fs.files], before);
});

test("measurement repair: file path components and inline code are not bare Node handles, while ordinary punctuation remains references", () => {
  const nodes = [
    { nodeId: "node-known", name: "Known", path: "Known", raw: "", body: "", data: {} },
  ];
  const body = [
    "test/node-known.test.ts src/core/node-absent.ts test/foo-node-other.test.ts ./node-third.md",
    String.raw`src\node-windows.ts /tmp/node-known/child file.node-extension.ts`,
    "`src/node-inline.ts` node-known/suffix node-ending.ts",
    "node-known, (node-known); `node-known`. node-known.",
    "见node-known。以及“node-known”！node-missing.",
    "[explicit](node-known)",
  ].join("\n");
  const refs = resolveBodyNodeReferences(body, "cards/card-example.md", nodes);
  assert.deepEqual(
    refs.filter((ref) => ref.kind === "mention").map((ref) => ref.raw),
    ["node-known", "node-known", "node-known", "node-known", "node-known", "node-missing"],
  );
  assert.equal(refs.filter((ref) => ref.kind === "link" && ref.nodeId === "node-known").length, 1);
  assert.equal(
    refs.find((ref) => ref.raw === "node-missing")?.reason,
    "Node id unavailable in the selected source",
  );
});

test("prose code spans exclude Node examples while ordinary handles and links remain references", () => {
  const nodes = [
    {
      nodeId: "node-known",
      name: "Known",
      path: "Known",
      raw: "",
      body: "## Keep\nRule.",
      data: {},
    },
  ];
  const body = [
    "node-known「Keep」, node-known.",
    "`node-known` ``node-known `node-known` `` `node-nope00`",
    "`node-known\r\nnode-known`",
    "```text\nnode-known [example](node-known#Missing)\n```",
    "~~~\nnode-known\n~~~",
    "",
    "    node-known",
    "",
    String.raw`\` node-known \``,
    "[ordinary](node-known#Keep)",
  ].join("\n");
  const refs = resolveBodyNodeReferences(body, "cards/card-example.md", nodes);
  assert.deepEqual(
    refs.filter((ref) => ref.kind === "mention").map((ref) => ref.raw),
    ["node-known", "node-known", "node-known"],
  );
  assert.equal(refs.filter((ref) => ref.kind === "link").length, 1);
  assert.ok(refs.every((ref) => ref.nodeId === "node-known" && !ref.reason));
  assert.equal(refs.filter((ref) => ref.heading === "Keep").length, 2);
});

test("measurement repair: unique test files share all static witnesses before bounded revision-bound pages are chosen", async () => {
  const { fs, node } = await fixture();
  await node("Module", "node-module", "goal", "Use static witnesses.", {
    sources: [{ resource: "../../src/", track: "structure" }],
  });
  const tests = Array.from(
    { length: 12 },
    (_, i) => `test/case-${String(i).padStart(2, "0")}.test.ts`,
  );
  const repo: AgentContextRepository = {
    trackedFiles: ["src/a.ts", "src/b.ts", ...tests],
    sources: {
      errors: [],
      files: [
        { path: "src/a.ts", content: "export function A() {}" },
        { path: "src/b.ts", content: "export function B() {}" },
        ...tests.map((path) => ({
          path,
          content: 'import {A} from "../src/a"; import {B} from "../src/b"; A(); B();',
        })),
      ],
    },
  };
  const start = { kind: "node" as const, nodeId: "node-module" };
  const result = await assembleAgentContext(fs, root, start, { repository: repo });
  const first = section(result, "tests");
  assert.equal(first.total, 12);
  assert.equal(first.omitted, 2);
  assert.deepEqual(
    first.items.map((item) => item.path),
    tests.slice(0, 10),
  );
  assert.ok(
    first.items.every((item) => item.why.includes("src/a.ts") && item.why.includes("src/b.ts")),
  );
  const reversed = {
    trackedFiles: [...repo.trackedFiles].reverse(),
    sources: { files: [...repo.sources.files].reverse(), errors: [] },
  };
  assert.deepEqual(await assembleAgentContext(fs, root, start, { repository: reversed }), result);
  const next = await assembleAgentContext(fs, root, start, { repository: repo, ...first.next });
  assert.deepEqual(
    section(next, "tests").items.map((item) => item.path),
    tests.slice(10),
  );
  assert.equal(section(next, "tests").omitted, 0);
  const changed = {
    trackedFiles: repo.trackedFiles,
    sources: {
      files: repo.sources.files.map((file) =>
        file.path === tests[0] ? { ...file, content: 'import {A} from "../src/a"; A();' } : file,
      ),
      errors: [],
    },
  };
  await assert.rejects(
    assembleAgentContext(fs, root, start, { repository: changed, ...first.next }),
    /source changed/,
  );
});

test("measurement repair: rule excerpts skip syntactic metadata and thematic breaks without inventing text for empty bodies", async () => {
  const { fs, node } = await fixture();
  const bodies = [
    "---\nstatus: draft\n---\n# Heading\n\n---\nKeep current evidence. More detail.",
    "---\nKeep current evidence. More detail.",
    "* * *\nKeep current evidence. More detail.",
    "___\nKeep current evidence. More detail.",
    "",
    "---",
    "---\nstatus: draft\n---\n",
  ];
  for (const [i, body] of bodies.entries()) {
    await node(`Scope${i}`, `node-scope${i}`, "goal", body, {
      description: "This metadata must never become a body excerpt",
    });
    await node(`Scope${i}/Task`, `node-task${i}`, "goal", "Do the task.");
    const result = await assembleAgentContext(fs, root, { kind: "node", nodeId: `node-task${i}` });
    const item = section(result, "rules").items.find((item) => item.nodeId === `node-scope${i}`)!;
    assert.equal(item.text?.trim(), i < 4 ? "Keep current evidence." : "");
    assert.ok(!item.text || body.includes(item.text));
    assert.doesNotMatch(item.text ?? "", /description|status:|type:|node-scope/);
  }
});

test("measurement repair: explicit pinned and Markdown fragments select exact late sections; natural-language headings do not", async () => {
  const { fs, node, save } = await fixture();
  const intro = "Long unrelated introduction. ".repeat(100);
  await node(
    "Target",
    "node-target",
    "goal",
    `${intro}\n## Exact Topic\nRequired source bytes.\n## End\nExcluded ending.\n`,
  );
  const basis = await save();
  for (const [id, fragment] of [
    ["card-selected", "#Exact%20Topic"],
    ["card-whole", ""],
    ["card-missing", "#Missing"],
  ]) {
    const resource = `../Target/Target.md${fragment}`;
    await fs.writeFile(
      `cards/${id}.md`,
      serializeFrontmatter(
        {
          id,
          type: "card",
          schemaVersion: 3,
          state: "pending",
          sources: [{ resource, version: { commit: basis, path: "Target/Target.md" } }],
        },
        fragment ? `[source](${resource})` : "Read the Exact Topic policy table in node-target.",
      ),
    );
  }
  await save();
  const selected = await assembleAgentContext(fs, root, { kind: "card", cardId: "card-selected" });
  const selectedRefs = section(selected, "references").items.filter(
    (item) => item.nodeId === "node-target",
  );
  assert.ok(selectedRefs.length >= 1);
  assert.ok(
    selectedRefs.every(
      (item) =>
        item.heading === "Exact Topic" && item.text === "## Exact Topic\nRequired source bytes.\n",
    ),
  );
  const whole = await assembleAgentContext(fs, root, { kind: "card", cardId: "card-whole" });
  const wholeRefs = section(whole, "references").items.filter(
    (item) => item.nodeId === "node-target",
  );
  assert.ok(wholeRefs.length >= 1);
  assert.ok(
    wholeRefs.every(
      (item) => item.heading === undefined && item.truncated && item.text === intro.slice(0, 1600),
    ),
  );
  const missing = await assembleAgentContext(fs, root, { kind: "card", cardId: "card-missing" });
  const fallback = section(missing, "references").items.find(
    (item) => item.nodeId === "node-target",
  )!;
  assert.equal(fallback.heading, undefined);
  assert.equal(fallback.text, intro.slice(0, 1600));
  assert.equal(fallback.truncated, true);
  assert.ok(section(missing, "unknown").items.some((item) => item.why.includes("section")));
});
