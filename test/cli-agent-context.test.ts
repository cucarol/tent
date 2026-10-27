import assert from "node:assert/strict";
import test, { after } from "node:test";
import path from "node:path";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { initializeFixtureWorkspace } from "./scratch.js";
import { serializeFrontmatter } from "../src/core/base/frontmatter.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { runCardCommand } from "../src/cli/card-commands.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import {
  projectAgentContext,
  formatAgentContextPage,
  type AgentContextPage,
} from "../src/core/read/agent-context-page.js";
import { assembleAgentContext, type AgentContext } from "../src/core/read/agent-context.js";
import { projectAgentBrief, formatAgentBrief } from "../src/core/read/agent-brief.js";
import { inspectCurrentContext } from "../src/core/read/context-brief.js";
import { PropagationMemoryFs } from "./propagation-memory.js";
import { scaffoldTent } from "../src/core/store/scaffold.js";
import { transactionResult } from "../src/cli/transaction-result.js";
import { agentContextOutput } from "../src/cli/agent-context.js";
import { readNode } from "../src/core/read/node-query.js";
import { readWorkspaceSettings } from "../src/core/workspace/workspace-settings.js";
import { WORKSPACE_SETTINGS_PATH } from "../src/core/base/paths.js";
import type { NodeFs } from "../src/fs/node-fs.js";
import { pageText } from "../src/cli/reader-page.js";

const scratch = path.resolve(".scratch/decisions-cli");
const result = (response: { exitCode: number; stdout: string; stderr: string }) => {
  assert.equal(response.exitCode, 0, response.stderr);
  return JSON.parse(response.stdout);
};
const bytes = (text: string) => Buffer.byteLength(text);
let sequence = 0;
async function evidence(label: string, response: { stdout: string; stderr: string }) {
  await fs.writeFile(path.join(scratch, `cli-${sequence++}-${label}.stdout`), response.stdout);
  await fs.writeFile(path.join(scratch, `cli-${sequence - 1}-${label}.stderr`), response.stderr);
}
async function fixture() {
  await fs.mkdir(scratch, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(scratch, "cli-workspace-"));
  await initializeFixtureWorkspace(workspace);
  await fs.mkdir(path.join(workspace, "src"));
  await fs.mkdir(path.join(workspace, "test"));
  await fs.writeFile(path.join(workspace, "README.md"), "Unparsed repository material.");
  for (const name of ["a", "b"]) {
    await fs.writeFile(path.join(workspace, `src/${name}.ts`), `export const ${name}=1;`);
    await fs.writeFile(
      path.join(workspace, `test/${name}.test.ts`),
      `import {${name}} from '../src/${name}'; console.log(${name});`,
    );
  }
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  );
  execFileSync("git", ["-C", workspace, "add", "src", "test", "README.md"], {
    env,
    windowsHide: true,
  });
  for (let index = 0; index < 5; index++) {
    const name = `Source${index}`;
    await fs.mkdir(path.join(workspace, ".tent", name));
    await fs.writeFile(
      path.join(workspace, ".tent", name, `${name}.md`),
      serializeFrontmatter(
        { id: `node-z${index}`, type: "goal", resource: "../../src/a.ts" },
        "汉😀".repeat(3000) + "\r\nnode-absent src/b.ts.",
      ),
    );
  }
  const created = await runCardCommand(
    "create",
    [
      "--id",
      "card-page",
      "--prompt",
      "P".repeat(20000),
      ...Array.from({ length: 5 }, (_, index) => ["--source", `node-z${4 - index}`]).flat(),
    ],
    { workspace, json: true },
  );
  result(created);
  assert.ok((await fs.stat(path.join(workspace, ".tent/.git/history.sqlite"))).isFile());
  await assert.rejects(fs.stat(path.join(workspace, ".tent/.git/HEAD")), { code: "ENOENT" });
  await fs.writeFile(path.join(scratch, "cli-workspace.txt"), workspace + "\n");
  return workspace;
}
let pendingWorkspace: Promise<string> | undefined;
const workspace = () => (pendingWorkspace ??= fixture());
after(async () => {
  if (!pendingWorkspace) return;
  const root = await pendingWorkspace;
  assert.ok(root.startsWith(scratch + path.sep));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
});

test("CLI context Node: bounded first body, exact full/raw/batch and unchanged continuation addresses", async () => {
  const root = await workspace();
  const response = await runNodeCommand("get", ["node-z0"], { workspace: root, json: true });
  await evidence("node-first", response);
  const first = result(response);
  assert.ok(first.agentContext);
  assert.ok(bytes(response.stdout) <= 16384);
  assert.ok(
    first.agentContext.sections
      .find((section: { kind: string }) => section.kind === "references")
      .items.some((item: { nodeId?: string }) => item.nodeId === "node-z0"),
  );
  assert.deepEqual(
    first.agentContext.sections
      .find((section: { kind: string }) => section.kind === "tests")
      .items.map((item: { path: string }) => item.path),
    ["test/a.test.ts"],
  );
  assert.ok(Array.from(first.text).length <= 1600);
  assert.ok(first.partial);
  assert.match(first.etag, /^read:/);
  const next = await runNodeCommand(
    "get",
    ["node-z0", "--cursor", first.page.nextCursor, "--expected-etag", first.page.next.expectedEtag],
    { workspace: root, json: true },
  );
  await evidence("node-next", next);
  const continued = result(next);
  assert.equal(continued.agentContext, undefined);
  const full = await runNodeCommand("get", ["node-z0", "--full"], { workspace: root, json: true });
  await evidence("node-full", full);
  const complete = result(full);
  assert.ok(complete.text.length > first.text.length);
  assert.ok(!complete.etag.startsWith("read:"));
  assert.equal(complete.agentContext, undefined);
  assert.equal(
    complete.text.slice(first.range.end, first.range.end + continued.text.length),
    continued.text,
  );
  for (const args of [
    ["get", "node-z0", "--view", "raw"],
    ["read-many", "node-z0", "node-z1"],
  ]) {
    const output = result(
      await runNodeCommand(args[0]!, args.slice(1), { workspace: root, json: true }),
    );
    assert.equal(output.agentContext, undefined);
  }
  const text = await runNodeCommand("get", ["node-z0"], { workspace: root });
  await evidence("node-text", text);
  assert.equal(text.exitCode, 0, text.stderr);
  assert.ok(bytes(text.stdout) <= 16384);
});

test("CLI context Card: source-order half-page originals, show/take and --start continuation", async () => {
  const root = await workspace();
  const response = await runCardCommand("show", ["card-page"], { workspace: root, json: true });
  await evidence("card-first", response);
  const first = result(response);
  assert.ok(first.agentContext);
  assert.ok(bytes(response.stdout) <= 16384);
  const refs = first.agentContext.sections.find(
    (section: { kind: string }) => section.kind === "references",
  ).items;
  assert.deepEqual(
    refs
      .filter((item: { nodeId?: string }) => item.nodeId)
      .map((item: { nodeId: string }) => item.nodeId),
    ["node-z4", "node-z3", "node-z2", "node-z1", "node-z0"],
  );
  const originalBytes =
    bytes(JSON.stringify(first.text)) +
    refs.reduce(
      (sum: number, item: { text?: string }) =>
        sum + (item.text ? bytes(JSON.stringify(item.text)) : 0),
      0,
    );
  assert.ok(originalBytes <= 8192);
  assert.ok(refs.some((item: { textOmitted?: boolean }) => item.textOmitted));
  const next = first.page.next;
  const continued = await runCardCommand(
    "show",
    [
      "card-page",
      "--start",
      String(next.range.start),
      "--end",
      String(next.range.end),
      "--expected-etag",
      next.expectedEtag,
    ],
    { workspace: root, json: true },
  );
  await evidence("card-next", continued);
  const page = result(continued);
  assert.equal(page.agentContext, undefined);
  assert.equal(page.text, "P".repeat(page.range.end - page.range.start));
  const raw = result(
    await runCardCommand("show", ["card-page", "--view", "raw"], { workspace: root, json: true }),
  );
  assert.equal(raw.agentContext, undefined);
  const text = await runCardCommand("show", ["card-page"], { workspace: root });
  await evidence("card-text", text);
  assert.equal(text.exitCode, 0, text.stderr);
  assert.ok(bytes(text.stdout) <= 16384);
  const take = await runCardCommand("take", ["card-page"], { workspace: root, json: true });
  await evidence("card-take", take);
  assert.ok(result(take).agentContext);
  assert.ok(bytes(take.stdout) <= 16384);
});

test("CLI context resource and brief: first page wiring, timed facts and preserved native capture", async () => {
  const root = await workspace();
  const response = await runNodeCommand("search", ["--resource", "src/a.ts", "--limit", "1"], {
    workspace: root,
    json: true,
  });
  await evidence("resource-first", response);
  const first = result(response);
  assert.ok(
    first.agentContext.sections
      .find((section: { kind: string }) => section.kind === "references")
      .items.some((item: { nodeId?: string }) => item.nodeId === "node-z0"),
  );
  assert.deepEqual(
    first.agentContext.sections
      .find((section: { kind: string }) => section.kind === "tests")
      .items.map((item: { path: string }) => item.path),
    ["test/a.test.ts"],
  );
  assert.ok(first.agentContext);
  assert.ok(bytes(response.stdout) <= 16384);
  const next = result(
    await runNodeCommand(
      "search",
      ["--resource", "src/a.ts", "--limit", "1", "--cursor", first.page.nextCursor],
      { workspace: root, json: true },
    ),
  );
  assert.equal(next.agentContext, undefined);
  const file = path.join(root, ".tent/Source0/Source0.md");
  await fs.appendFile(file, "\nA newly retained edit.\n");
  const brief = await runWorkspaceCommand("brief", [], { workspace: root, json: true });
  await evidence("brief", brief);
  const value = result(brief);
  assert.ok(value.agentContext);
  assert.ok(bytes(brief.stdout) <= 16384);
  const recent = value.agentContext.sections.find(
    (section: { kind: string }) => section.kind === "references",
  ).items;
  assert.equal(recent[0].nodeId, "node-z0");
  assert.match(recent[0].at, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(!JSON.stringify(value.agentContext).includes("Last session"));
});

test("CLI context projection: later categories compress first; unknown text and source bytes stay explicit", () => {
  const kinds = [
    "references",
    "rules",
    "paths",
    "tests",
    "changes",
    "decisions",
    "open",
    "unknown",
  ] as const;
  const context: AgentContext = {
    start: { kind: "node", nodeId: "node-root" },
    revision: "a".repeat(64),
    sections: kinds.map((kind) => ({
      kind,
      total: 10,
      omitted: 0,
      items: Array.from({ length: 10 }, (_, index) => ({
        nodeId: `node-item${index}`,
        title: `Title ${index}`,
        path: "path/" + "q".repeat(200),
        why: "😀".repeat(180),
        text: kind === "references" ? "source" : "content".repeat(40),
      })),
    })),
  };
  const before = JSON.stringify(context);
  const measure = (page: AgentContextPage) =>
    Math.max(
      bytes(JSON.stringify({ agentContext: page }) + "\n"),
      bytes(formatAgentContextPage(page) + "\n"),
    );
  const page = projectAgentContext(context, "/fixture", { text: "", bytes: 2 }, measure);
  assert.ok(measure(page) <= 16384);
  const unknown = page.sections.at(-1)!;
  assert.equal(unknown.items.length, 10);
  assert.ok(unknown.items.every((item) => Array.from(item.why!).length <= 120));
  assert.ok(
    unknown.items.some(
      (item) => item.why?.startsWith("😀") && Array.from(item.why).length === 120 && item.truncated,
    ),
  );
  assert.ok(unknown.items.some((item) => item.why?.includes("omitted; no CLI lists all")));
  assert.equal(unknown.omitted, unknown.total - unknown.items.length);
  assert.ok(page.sections.some((section) => section.display));
  assert.equal(unknown.display, undefined);
  assert.ok(!page.sections.find((section) => section.kind === "references")?.display);
  assert.equal(JSON.stringify(context), before);
  assert.match(page.readNotice, /not the exact computed union/);
  const filename = "folder/".repeat(8) + "document.md";
  const diff = `diff --git a/${filename} b/${filename}\n--- a/${filename}\n+++ b/${filename}\n@@ -1 +1 @@\n-old\n+new\n`;
  const evidence: AgentContext = {
    ...context,
    sections: kinds.map((kind) => ({
      kind,
      total: kind === "changes" ? 1 : 0,
      omitted: 0,
      items: kind === "changes" ? [{ why: "Retained Node version diff", text: diff }] : [],
    })),
  };
  const change = projectAgentContext(
    evidence,
    "/fixture",
    { text: "", bytes: 2 },
    measure,
  ).sections.find((section) => section.kind === "changes")!.items[0]!;
  assert.equal(change.text, diff);
});

test("CLI context summary: an explicit summary does not falsely claim original text is above", async () => {
  const root = await workspace();
  const response = await runNodeCommand("get", ["node-z0", "--view", "summary"], {
    workspace: root,
    json: true,
  });
  await evidence("node-summary", response);
  const value = result(response);
  assert.ok(value.agentContext);
  assert.equal(value.text, undefined);
  const original = value.agentContext.sections
    .find((section: { kind: string }) => section.kind === "references")
    .items.find((item: { nodeId: string }) => item.nodeId === "node-z0");
  assert.equal(original.textInBody, undefined);
  assert.ok(original.text?.length);
  assert.ok(bytes(response.stdout) <= 16384);
});

test("CLI context newline budget: existing body pages reserve the terminator and preserve every byte", () => {
  const source = {
    cardId: "card-plain",
    text: "x".repeat(20000),
    etag: "e".repeat(24),
    view: "body",
    viewLength: 20000,
    range: { unit: "utf16" as const, start: 0, end: 20000 },
  };
  const first = pageText(source, "card.show:card-plain");
  assert.ok(bytes(JSON.stringify(first) + "\n") <= 16384);
  const next = pageText(source, "card.show:card-plain", { cursor: first.page.nextCursor });
  assert.ok(bytes(JSON.stringify(next) + "\n") <= 16384);
  assert.equal(first.text + next.text, source.text);
  assert.equal(next.range.start, first.range.end);
});

test("CLI context protected labels: source metadata shares the original half-page instead of overflowing with Unicode unknowns", () => {
  const kinds = [
    "references",
    "rules",
    "paths",
    "tests",
    "changes",
    "decisions",
    "open",
    "unknown",
  ] as const;
  const envelope = {
    cardId: "card-many",
    text: "P".repeat(1600),
    sources: Array.from({ length: 10 }, () => ({ resource: "material/" + "汉".repeat(40) })),
  };
  const context: AgentContext = {
    start: { kind: "card", cardId: "card-many" },
    revision: "b".repeat(64),
    sections: kinds.map((kind) => ({
      kind,
      total: kind === "references" || kind === "unknown" ? 10 : 0,
      omitted: 0,
      items:
        kind === "references"
          ? Array.from({ length: 10 }, (_, index) => ({
              nodeId: `node-source${index}`,
              title: "汉".repeat(72),
              why: "Pinned source " + "汉".repeat(160),
              path: ".tent/" + "汉".repeat(160),
              version: { commit: "c".repeat(64), path: "父/".repeat(50) + "汉".repeat(72) + ".md" },
              text: "😀".repeat(1600),
            }))
          : kind === "unknown"
            ? Array.from({ length: 10 }, () => ({ why: "Unavailable " + "😀".repeat(160) }))
            : [],
    })),
  };
  const measure = (page: AgentContextPage) =>
    Math.max(
      bytes(JSON.stringify({ ...envelope, agentContext: page }) + "\n"),
      bytes(JSON.stringify(envelope) + formatAgentContextPage(page) + "\n"),
    );
  const primary = {
    text: envelope.text,
    cardId: envelope.cardId,
    bytes: bytes(JSON.stringify(envelope)),
  };
  const page = projectAgentContext(context, "/fixture", primary, measure);
  assert.ok(measure(page) <= 16384);
  const refs = page.sections[0]!;
  assert.ok(refs.items.length > 0 && refs.items.length < 10);
  assert.equal(refs.items.length + refs.omitted, refs.total);
  assert.ok(
    refs.items.every(
      (item, index) =>
        item.nodeId === `node-source${index}` &&
        item.version?.commit === "c".repeat(64) &&
        item.version.path === "父/".repeat(50) + "汉".repeat(72) + ".md",
    ),
  );
  assert.ok(
    primary.bytes + refs.items.reduce((sum, item) => sum + bytes(JSON.stringify(item)), 0) <= 8192,
  );
  assert.equal(page.sections.at(-1)!.items.length, 10);
  assert.ok(refs.items.some((item) => item.textOmitted));
  assert.equal(
    JSON.stringify(projectAgentContext(context, "/fixture", primary, measure)),
    JSON.stringify(page),
  );
});

test("CLI context protected pins: omitted excerpts retain exact version and section identities", () => {
  const kinds = [
    "references",
    "rules",
    "paths",
    "tests",
    "changes",
    "decisions",
    "open",
    "unknown",
  ] as const;
  for (const note of [
    "Task/Task.md",
    "父/".repeat(50) + "汉".repeat(72) + "/" + "汉".repeat(72) + ".md",
  ]) {
    const sources = Array.from({ length: 9 }, (_, index) => ({
      nodeId: "node-source",
      title: "汉".repeat(72),
      path: `.tent/${note}`,
      why: `Card card-pins pinned source: ../${note}#${index % 2 ? "Second" : "First"}`,
      version: { commit: String(index + 1).repeat(64), path: note },
      heading: index % 2 ? "Second" : "First",
      text: "😀".repeat(1600),
    }));
    const envelope = {
      cardId: "card-pins",
      text: "P".repeat(1600),
      sourcesOmitted: true,
      metadataRead: { cardId: "card-pins", view: "raw" },
    };
    const context: AgentContext = {
      start: { kind: "card", cardId: "card-pins" },
      revision: "b".repeat(64),
      sections: kinds.map((kind) => ({
        kind,
        total: kind === "references" ? 10 : 0,
        omitted: 0,
        items:
          kind === "references"
            ? [
                {
                  cardId: "card-pins",
                  why: "Immutable published Card request",
                  text: envelope.text,
                },
                ...sources,
              ]
            : [],
      })),
    };
    const primary = {
      text: envelope.text,
      bytes: bytes(JSON.stringify(envelope)),
      cardId: envelope.cardId,
    };
    const measure = (page: AgentContextPage) =>
      Math.max(
        bytes(JSON.stringify({ ...envelope, agentContext: page }) + "\n"),
        bytes(JSON.stringify(envelope) + "\n\n" + formatAgentContextPage(page) + "\n"),
      );
    const before = JSON.stringify(context);
    const page = projectAgentContext(context, "/fixture", primary, measure);
    const references = page.sections.find((section) => section.kind === "references")!;
    const shown = references.items.filter((item) => item.nodeId);
    assert.ok(shown.length > 0);
    assert.ok(shown.some((item) => item.textOmitted));
    assert.deepEqual(
      shown.map((item) => ({ version: item.version, heading: item.heading })),
      sources
        .slice(0, shown.length)
        .map((item) => ({ version: item.version, heading: item.heading })),
    );
    if (note === "Task/Task.md") assert.equal(shown.length, 9);
    else {
      assert.ok(shown.length < 9);
      assert.ok(references.omitted > 0);
      assert.match(
        formatAgentContextPage(page),
        new RegExp(
          `${references.omitted} source entries omitted; Card raw below lists all source addresses and versions`,
        ),
      );
      assert.ok(
        page.sourceReads.some((read) => read.command?.includes("card show card-pins --view raw")),
      );
    }
    assert.equal(references.items.length + references.omitted, references.total);
    assert.ok(
      primary.bytes +
        references.items.reduce((sum, item) => sum + bytes(JSON.stringify(item)), 0) <=
        8192,
    );
    assert.ok(measure(page) <= 16384);
    assert.equal(JSON.stringify(context), before);
    assert.equal(
      JSON.stringify(projectAgentContext(context, "/fixture", primary, measure)),
      JSON.stringify(page),
    );
    const text = formatAgentContextPage(page);
    for (const item of shown) {
      assert.ok(text.includes(JSON.stringify(item.version)));
      assert.ok(text.includes(`Section: ${item.heading}`));
    }
  }
});

test("CLI context omitted tests: eleven real import witnesses report the missing CLI continuation and related Node", async () => {
  const memory = new PropagationMemoryFs();
  await scaffoldTent(memory, { name: "List continuation" });
  await memory.writeFile(
    "Task/Task.md",
    serializeFrontmatter(
      { id: "node-reader", type: "goal", resource: "../../src/a.ts" },
      "Use the file.",
    ),
  );
  const files = [
    { path: "src/a.ts", content: "export const a = 1;" },
    ...Array.from({ length: 11 }, (_, index) => ({
      path: `test/t${String(index).padStart(2, "0")}.test.ts`,
      content: "import { a } from '../src/a'; a;",
    })),
  ];
  const context = await assembleAgentContext(
    memory,
    path.join(scratch, "omitted-list-memory"),
    { kind: "node", nodeId: "node-reader" },
    {
      repository: { trackedFiles: files.map((file) => file.path), sources: { files, errors: [] } },
    },
  );
  const tests = context.sections.find((section) => section.kind === "tests")!;
  assert.equal(tests.total, 11);
  assert.equal(tests.items.length, 10);
  assert.equal(tests.omitted, 1);
  const envelope = { nodeId: "node-reader", text: "Use the file." };
  const measure = (page: AgentContextPage) =>
    Math.max(
      bytes(JSON.stringify({ ...envelope, agentContext: page }) + "\n"),
      bytes(formatAgentContextPage(page) + "\n"),
    );
  const page = projectAgentContext(
    context,
    "/fixture",
    { ...envelope, bytes: bytes(JSON.stringify(envelope)) },
    measure,
  );
  const projectedTests = page.sections.find((section) => section.kind === "tests")!;
  assert.equal(projectedTests.omitted, 1);
  const uncertainty = page.sections
    .find((section) => section.kind === "unknown")!
    .items.find((item) => item.why?.includes("1 tests omitted"));
  assert.equal(uncertainty?.nodeId, "node-reader");
  assert.match(uncertainty!.why!, /no CLI lists all.*own tools/);
  assert.match(page.readNotice, /Source commands read bodies only/);
  assert.ok(
    page.sourceReads.some((read) => read.command?.includes("tent node get node-reader --full")),
  );
  assert.match(
    formatAgentContextPage(page),
    /1 tests entries omitted; no CLI lists this complete assembled list/,
  );
  assert.ok(!formatAgentContextPage(page).includes("1 more; read each source below"));
  assert.ok(measure(page) <= 16384);
  assert.deepEqual(
    projectAgentContext(
      context,
      "/fixture",
      { ...envelope, bytes: bytes(JSON.stringify(envelope)) },
      measure,
    ),
    page,
  );
});

test("CLI context explicit first range: zero starts assemble while positive offsets remain plain continuation", async () => {
  const root = await workspace();
  const node = result(
    await runNodeCommand(
      "get",
      ["node-z0", "--range", JSON.stringify({ unit: "utf16", start: 0, end: 9 })],
      { workspace: root, json: true },
    ),
  );
  assert.ok(node.agentContext);
  assert.equal(node.text, "汉😀".repeat(3));
  const nodeNext = result(
    await runNodeCommand(
      "get",
      ["node-z0", "--range", JSON.stringify({ unit: "utf16", start: 9, end: 18 })],
      { workspace: root, json: true },
    ),
  );
  assert.equal(nodeNext.agentContext, undefined);
  assert.equal(nodeNext.text, node.text);
  const card = result(
    await runCardCommand("show", ["card-page", "--start", "0", "--end", "10"], {
      workspace: root,
      json: true,
    }),
  );
  assert.ok(card.agentContext);
  assert.equal(card.text, "P".repeat(10));
});

test("CLI brief bounded collections: 100 Cards, twelve timed Nodes and workspace problems keep priority and read-all addresses", async () => {
  const memory = new PropagationMemoryFs();
  await scaffoldTent(memory, { name: "Brief" });
  memory.history.completedCardPaths = async () => new Set();
  for (let index = 0; index < 100; index++)
    await memory.writeFile(
      `cards/card-boundary${index}.md`,
      serializeFrontmatter(
        {
          id: `card-boundary${index}`,
          type: "card",
          schemaVersion: 3,
          state: "pending",
          title: "汉".repeat(72),
          sources: [],
        },
        "Read input.",
      ),
    );
  for (let index = 0; index < 12; index++)
    await memory.writeFile(
      `Recent${index}/Recent${index}.md`,
      serializeFrontmatter({ id: `node-recent${index}`, type: "goal" }, "Retained change."),
    );
  await memory.history.captureUnlocked(
    [...memory.files].map(([path, raw]) => ({ path, raw })),
    { operation: "test.capture" },
  );
  const invalidNodes = Array.from({ length: 100 }, (_, index) => ({
    nodeId: `node-invalid${index}`,
    path: `Invalid${index}/Invalid${index}.md`,
    reason: "😀".repeat(150),
  }));
  const observed = await inspectCurrentContext(memory, {
    nodes: Promise.resolve({ invalidNodes }),
  });
  const facts = await assembleAgentContext(memory, "/fixture", { kind: "brief" });
  const output = projectAgentBrief(observed, facts, "/fixture");
  const cards = output.agentContext.sections.find((section) => section.kind === "open")!;
  const nodes = output.agentContext.sections.find((section) => section.kind === "references")!;
  assert.equal(cards.total, 100);
  assert.equal(cards.items.length, 10);
  assert.equal(cards.omitted, 90);
  assert.deepEqual(
    cards.items.map((item) => item.cardId),
    [
      "card-boundary0",
      "card-boundary1",
      "card-boundary10",
      "card-boundary11",
      "card-boundary12",
      "card-boundary13",
      "card-boundary14",
      "card-boundary15",
      "card-boundary16",
      "card-boundary17",
    ],
  );
  assert.equal(nodes.total, 12);
  assert.ok(nodes.items.length <= 10);
  assert.equal(nodes.omitted, nodes.total - nodes.items.length);
  assert.equal(output.workspaceIssues.items.length, 10);
  assert.ok(output.workspaceIssues.omitted >= 90);
  assert.ok(
    output.workspaceIssues.items.every((item, index) => item.nodeId === `node-invalid${index}`),
  );
  const text = formatAgentBrief(output);
  assert.ok(bytes(JSON.stringify(output) + "\n") <= 16384);
  assert.ok(bytes(text + "\n") <= 16384);
  assert.ok(
    text
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .every((line) => Array.from(line).length <= 120),
  );
  for (const item of cards.items) assert.ok(text.includes(item.cardId!));
  assert.ok(
    output.agentContext.sourceReads.some((read) =>
      read.command?.includes("card list --state pending"),
    ),
  );
  assert.ok(
    output.agentContext.sourceReads.some((read) => read.command?.includes("workspace check")),
  );
  assert.equal(
    JSON.stringify(projectAgentBrief(observed, facts, "/fixture")),
    JSON.stringify(output),
  );
  await fs.mkdir(scratch, { recursive: true });
  await fs.writeFile(path.join(scratch, "bounded-brief.json"), JSON.stringify(output) + "\n");
  await fs.writeFile(path.join(scratch, "bounded-brief.txt"), text + "\n");
  process.stdout.write(
    JSON.stringify({
      case: "bounded-brief",
      cards: cards.items.length,
      cardsTotal: cards.total,
      recentNodes: nodes.items.length,
      recentTotal: nodes.total,
      problems: output.workspaceIssues.items.length,
      problemsTotal: output.workspaceIssues.total,
      jsonBytes: bytes(JSON.stringify(output) + "\n"),
      textBytes: bytes(text + "\n"),
    }) + "\n",
  );
});

test("CLI brief recovery display: outer renderer cannot append an unbounded conflict collection", async () => {
  let closed = false;
  const adapter = {
    ready: async () => {},
    close: async () => {
      closed = true;
    },
    recoveryConflicts: Array.from({ length: 100 }, () => "path/" + "汉".repeat(72)),
  } as unknown as NodeFs;
  const response = await transactionResult(async (opened) => {
    await opened(adapter);
    return {
      stdout: JSON.stringify({ workspaceIssues: { total: 100, omitted: 90 } }) + "\n",
      stderr: "",
    };
  }, "workspace.brief");
  assert.equal(JSON.parse(response.stdout).recoveryConflicts, undefined);
  assert.ok(bytes(response.stdout + response.stderr) < 16384);
  assert.match(response.stderr, /100 external edits/);
  assert.match(response.stderr, /workspace check/);
  assert.equal(closed, true);
});

test("API context source revision: edits beyond visible excerpts invalidate continuation", async () => {
  const memory = new PropagationMemoryFs();
  await scaffoldTent(memory, { name: "Revision" });
  memory.history.completedCardPaths = async () => new Set();
  const put = (body: string) =>
    memory.writeFile("Root/Root.md", serializeFrontmatter({ id: "node-root", type: "goal" }, body));
  await put("A".repeat(1600) + "old tail");
  for (let index = 0; index < 11; index++)
    await memory.writeFile(
      `Root/Child${index}/Child${index}.md`,
      serializeFrontmatter({ id: `node-child${index}`, type: "goal" }, ""),
    );
  const repository = { trackedFiles: [], sources: { files: [], errors: [] } };
  const first = await assembleAgentContext(
    memory,
    scratch,
    { kind: "node", nodeId: "node-root" },
    { repository },
  );
  const next = first.sections.find((section) => section.kind === "open")!.next!;
  assert.ok(next);
  await put("A".repeat(1600) + "different tail");
  await assert.rejects(
    assembleAgentContext(
      memory,
      scratch,
      { kind: "node", nodeId: "node-root" },
      { repository, ...next },
    ),
    /source changed/i,
  );
  await put("A".repeat(1600) + "old tail");
  const sourceRepository = {
    trackedFiles: ["unseen.ts"],
    sources: { files: [{ path: "unseen.ts", content: "export const value=1;" }], errors: [] },
  };
  const observed = await assembleAgentContext(
    memory,
    scratch,
    { kind: "node", nodeId: "node-root" },
    { repository: sourceRepository },
  );
  const page = observed.sections.find((section) => section.kind === "open")!.next!;
  sourceRepository.sources.files[0]!.content = "export const value=2;";
  await assert.rejects(
    assembleAgentContext(
      memory,
      scratch,
      { kind: "node", nodeId: "node-root" },
      { repository: sourceRepository, ...page },
    ),
    /source changed/i,
  );
});

test("CLI context read basis: a stale primary body cannot be labelled with newly assembled facts", async () => {
  const memory = new PropagationMemoryFs();
  await scaffoldTent(memory, { name: "Basis" });
  memory.history.completedCardPaths = async () => new Set();
  const put = (body: string) =>
    memory.writeFile("Root/Root.md", serializeFrontmatter({ id: "node-root", type: "goal" }, body));
  await put("First input");
  await memory.writeFile(WORKSPACE_SETTINGS_PATH, JSON.stringify({ workspaceId: "ws-basis" }));
  const { workspaceId } = await readWorkspaceSettings(memory);
  assert.ok(workspaceId);
  const first = (
    await readNode(memory, workspaceId, {
      nodeId: "node-root",
      view: "body",
      range: { unit: "utf16", start: 0, end: 5 },
    })
  ).node;
  assert.ok("text" in first && "etag" in first);
  await put("Second input");
  await assert.rejects(
    agentContextOutput(
      memory,
      path.join(scratch, "basis-virtual-only"),
      { kind: "node", nodeId: "node-root" },
      { nodeId: "node-root", text: first.text, etag: first.etag },
      true,
      JSON.stringify,
    ),
    /changed/i,
  );
});
