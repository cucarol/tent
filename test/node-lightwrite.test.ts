import { openTestFs, removeTestFixture } from "./node-fs.js";
import { historyHead } from "./scratch.js";
import { initializeFixtureHistory } from "./scratch.js";
import { testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { createNode } from "../src/core/graph/ops.js";
import { readNodeForEdit } from "../src/core/read/node-query.js";
import { contentEtag } from "../src/core/base/etag.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/base/frontmatter.js";
import { writeNodeDocument } from "../src/core/graph/node-document-write.js";
import { captureNativeNodeEdits } from "../src/core/graph/node-native-capture.js";
import { appendNodeBody } from "../src/core/write/node-lightwrite.js";
import { NodeSectionError, selectSection } from "../src/core/base/markdown-section.js";
import { cli, extendTestLockWait } from "./helpers.js";

const lockTimeoutMessage =
  /^Tent mutation lock is still busy after waiting 8 seconds; wait for the other write to finish, then reread before retrying\.\nNext: tent workspace brief(?: --workspace .+)?\n$/;

async function fixture(t: TestContext, body = "") {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "node-lightwrite-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await scaffoldInWorkspace(openTestFs(root), {
    name: "Lightwrite",
    nodes: [
      { id: "node-note", name: "Note", type: "prompt", body },
      { id: "node-peer", name: "Peer", type: "prompt", body: "peer" },
    ],
  });
  const tentRoot = path.join(root, ".tent");
  await initializeFixtureHistory(tentRoot);
  return { root, tentRoot, adapter: openTestFs(tentRoot), peer: openTestFs(tentRoot) };
}

async function readSection(adapter: NodeFs, nodeId: string, heading: string) {
  return selectSection((await readNodeForEdit(adapter, nodeId)).body, heading);
}

test("append requires no caller read, normalizes boundary newlines, captures exact canonical bytes", async (t) => {
  const { adapter } = await fixture(t, "Keep indentation\n    code  \n\n\n");
  const saved = await appendNodeBody(adapter, "node-note", {
    body: "\n[next](node-peer)\n\n",
    heading: "Notes *literally*",
  });
  assert.equal(
    parseFrontmatter(saved.raw).body,
    "Keep indentation\n    code  \n\n## Notes \\*literally\\*\n\n[next](../Peer/Peer.md)\n",
  );
  assert.equal("generated" in parseFrontmatter(saved.raw).data, false);
  assert.equal(saved.etag, contentEtag(saved.raw));
  assert.ok(saved.version);
  assert.equal(await adapter.history.read(saved.version), saved.raw);
  assert.equal(
    (await readSection(adapter, "node-note", "Notes *literally*")).text,
    "## Notes \\*literally\\*\n\n[next](../Peer/Peer.md)\n",
  );
  await assert.rejects(async () => appendNodeBody(adapter, "node-note", { body: "" }), /nonempty/);
  await assert.rejects(
    async () => appendNodeBody(adapter, "node-note", { body: "x", heading: "bad\nheading" }),
    /single-line/,
  );
  await assert.rejects(appendNodeBody(adapter, "Note", { body: "x" }), /canonical Node id/);
});

test("append preserves CRLF and handles an empty body without a leading blank line", async (t) => {
  const { adapter } = await fixture(t);
  const raw = (await adapter.readFile("Note/Note.md")).replace(/\n/g, "\r\n");
  await adapter.writeFile("Note/Note.md", raw);
  const first = await appendNodeBody(adapter, "node-note", { body: "first\nsecond\n\n" });
  assert.equal(parseFrontmatter(first.raw).body, "first\r\nsecond\r\n");
  const second = await appendNodeBody(adapter, "node-note", { body: "third" });
  assert.equal(parseFrontmatter(second.raw).body, "first\r\nsecond\r\n\r\nthird\r\n");
});

test("overlapping independent writers wait and append without losing either payload", async (t) => {
  const { adapter, peer, tentRoot } = await fixture(t, "base");
  extendTestLockWait(t, adapter, tentRoot);
  extendTestLockWait(t, peer, tentRoot);
  const read = adapter.readFile.bind(adapter);
  let reached!: () => void,
    release!: () => void,
    paused = false;
  const reading = new Promise<void>((resolve) => (reached = resolve));
  const proceed = new Promise<void>((resolve) => (release = resolve));
  adapter.readFile = async (file) => {
    const raw = await read(file);
    if (!paused && file === "Note/Note.md") {
      paused = true;
      reached();
      await proceed;
    }
    return raw;
  };
  const first = appendNodeBody(adapter, "node-note", { body: "author one" });
  let settled = false;
  let second: Promise<unknown> | undefined;
  try {
    await reading;
    second = appendNodeBody(peer, "node-note", { body: "author two" }).finally(() => {
      settled = true;
    });
    await delay(100);
    assert.equal(settled, false, "the second append cannot pass the held mutation lock");
  } finally {
    release();
    await first;
    adapter.readFile = read;
  }
  await second;
  assert.equal(
    (await readNodeForEdit(peer, "node-note")).body,
    "base\n\nauthor one\n\nauthor two\n",
  );
});

test("Markdown AST section boundaries include children, ignore code and quoted headings, and reject ambiguity", async (t) => {
  const body =
    "Intro\n\n## **Plan**\nOne\n\n```md\n# Fake\n## Plan\n```\n\n    # Indented fake\n\n> # Quoted fake\n\n### Child\nchild\n\n## Next\nnext\n\nTop\n===\ntop\n";
  const { adapter } = await fixture(t, body);
  const plan = await readSection(adapter, "node-note", "Plan");
  assert.equal(plan.depth, 2);
  assert.equal(plan.text, body.slice(body.indexOf("## **Plan**"), body.indexOf("## Next")));
  const next = await readSection(adapter, "node-note", "Next");
  assert.equal(next.text, "## Next\nnext\n\n");
  assert.equal((await readSection(adapter, "node-note", "Top")).depth, 1);
  await assert.rejects(
    readSection(adapter, "node-note", "Fake"),
    (e) => e instanceof NodeSectionError && e.code === "SECTION_NOT_FOUND",
  );
  const current = await readNodeForEdit(adapter, "node-note");
  await writeNodeDocument(adapter, "node-note", {
    baseEtag: current.etag,
    body: body + "\n## Plan\nduplicate",
  });
  await assert.rejects(
    appendNodeBody(adapter, "node-note", { heading: "Plan", body: "replacement" }),
    (e) => e instanceof NodeSectionError && e.code === "SECTION_AMBIGUOUS",
  );
});

test("append preserves surrounding bytes and uses current sections after another writer's edit", async (t) => {
  const body = "intro  \n\n## First\noriginal\n\n## Second\n[keep](node-peer)\n";
  const { adapter, peer } = await fixture(t, body);
  const original = await readNodeForEdit(adapter, "node-note");
  await adapter.writeFile("Note/Note.md", serializeFrontmatter(original.frontmatter, body));
  const second = await appendNodeBody(peer, "node-note", {
    heading: "Second",
    body: "changed elsewhere",
  });
  const saved = await appendNodeBody(adapter, "node-note", {
    heading: "First",
    body: "[new](node-peer)",
  });
  assert.equal(
    parseFrontmatter(saved.raw).body,
    "intro  \n\n## First\noriginal\n\n[new](../Peer/Peer.md)\n\n## Second\n[keep](node-peer)\n\nchanged elsewhere\n",
  );
  assert.notEqual(second.etag, original.etag);
  assert.equal(saved.etag, contentEtag(saved.raw));
  assert.equal(await adapter.history.read(saved.version!), saved.raw);
  await assert.rejects(
    writeNodeDocument(adapter, "node-note", { baseEtag: original.etag, body: "stale overwrite" }),
    /etag conflict/i,
  );
  assert.equal((await readNodeForEdit(adapter, "node-note")).raw, saved.raw);
});

test("append keeps peer ATX and Setext headings intact without a payload final newline", async (t) => {
  const { adapter } = await fixture(
    t,
    "before\n\n## A\nalpha\n\n## B\nbeta\n\nSetext\n------\nsetext\n",
  );
  await appendNodeBody(adapter, "node-note", { heading: "A", body: "changed" });
  await appendNodeBody(adapter, "node-note", { heading: "B", body: "paragraph" });
  assert.equal(
    (await readSection(adapter, "node-note", "Setext")).text,
    "Setext\n------\nsetext\n",
  );
  assert.equal(
    (await readNodeForEdit(adapter, "node-note")).body,
    "before\n\n## A\nalpha\n\nchanged\n\n## B\nbeta\n\nparagraph\n\nSetext\n------\nsetext\n",
  );
});

test("lightweight ordinary saves preserve material declarations and standard material validation", async (t) => {
  const { root, adapter } = await fixture(t);
  const material = path.join(root, "material.txt");
  await fs.writeFile(material, "v1");
  const env = {
    fs: adapter,
    clock: { now: () => new Date().toISOString() },
    tentName: "Lightwrite",
  };
  const id = await createNode(env, {
    parentPath: "",
    name: "Material",
    type: "prompt",
    body: "## Evidence\noriginal\n\n## Notes\nexisting\n",
    sources: [{ resource: pathToFileURL(material).href }],
  });
  await fs.writeFile(material, "v2");
  await appendNodeBody(adapter, id, { body: "## Notes\nextra" });
  await appendNodeBody(adapter, id, { heading: "Evidence", body: "updated" });
  const live = await readNodeForEdit(adapter, id);
  assert.deepEqual(live.frontmatter.sources, [{ resource: pathToFileURL(material).href }]);
  await adapter.writeFile(
    "Material/Material.md",
    serializeFrontmatter({ ...live.frontmatter, sources: [{ resource: "" }] }, live.body),
  );
  await assert.rejects(
    appendNodeBody(adapter, id, { body: "invalid metadata must fail" }),
    /Node not found/,
  );
  await assert.rejects(
    writeNodeDocument(adapter, id, {
      baseEtag: live.etag,
      body: "ordinary save also rejects invalid declarations",
    }),
    /Node not found/,
  );
});

test("real CLI create times out without changing bytes or history, then one caller retry creates once", async (t) => {
  const { root, tentRoot, adapter } = await fixture(t, "start");
  await captureNativeNodeEdits(adapter);
  const before = await readNodeForEdit(adapter, "node-note", { capture: true });
  const history = JSON.stringify(await adapter.history.changesInRange());
  const head = (await historyHead(tentRoot)).trim();
  let acquired!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => (acquired = resolve));
  const held = new Promise<void>((resolve) => (release = resolve));
  const holder = adapter.withLock("mutation.lock", async () => {
    acquired();
    await held;
  });
  const args = [
    "node",
    "create",
    "Retry",
    "--id",
    "node-retry",
    "--type",
    "prompt",
    "--body",
    "caller retry payload",
    "--json",
  ];
  try {
    await ready;
    const start = performance.now();
    const rejected = await cli(root, ...args);
    assert.equal(rejected.code, 1, rejected.stderr);
    assert.match(rejected.stderr, lockTimeoutMessage);
    assert.equal(rejected.stdout, "");
    assert.ok(performance.now() - start >= 8_000, "the real CLI keeps its eight-second wait");
    assert.equal(await adapter.readFile("Note/Note.md"), before.raw);
    assert.equal(await adapter.exists("Retry/Retry.md"), false);
    assert.equal((await historyHead(tentRoot)).trim(), head);
    assert.equal(JSON.stringify(await adapter.history.changesInRange()), history);
  } finally {
    release();
    await holder;
  }
  // Only a new caller invocation retries the failed action after the lock is released.
  const retried = await cli(root, ...args);
  assert.equal(retried.code, 0, retried.stderr);
  const saved = JSON.parse(retried.stdout).node;
  const current = await readNodeForEdit(adapter, "node-retry");
  assert.equal(current.body, "caller retry payload");
  assert.equal(saved.etag, contentEtag(current.raw));
  const version = (await adapter.history.pathVersions("Retry/Retry.md")).latest!;
  assert.ok(version);
  assert.equal(await adapter.history.read(version), current.raw);
  assert.equal(version.commit, (await historyHead(tentRoot)).trim());
  assert.equal((await adapter.history.changesInRange({ from: head })).length, 1);
  assert.equal(await adapter.readFile("Note/Note.md"), before.raw);
});

test("real CLI processes queue concurrent creates without losing either document or captured version", async (t) => {
  const { root, tentRoot, adapter } = await fixture(t, "start");
  await captureNativeNodeEdits(adapter);
  await readNodeForEdit(adapter, "node-note", { capture: true });
  const head = (await historyHead(tentRoot)).trim();
  const names = ["One", "Two"];
  const args = (name: string) => [
    "node",
    "create",
    name,
    "--id",
    `node-${name.toLowerCase()}`,
    "--type",
    "prompt",
    "--body",
    `process ${name}`,
    "--json",
  ];
  const results = await Promise.all(names.map((name) => cli(root, ...args(name))));
  t.diagnostic(
    `Concurrent CLI initial exit codes: ${results.map((result) => result.code).join(", ")}`,
  );
  assert.ok(
    results.some((result) => result.code === 0),
    JSON.stringify(results),
  );
  for (let i = 0; i < results.length; i++) {
    const name = names[i]!;
    let result = results[i]!;
    if (result.code !== 0) {
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, lockTimeoutMessage);
      assert.equal(await adapter.exists(`${name}/${name}.md`), false);
      // Both contenders have settled; a caller can retry a timed-out create once.
      result = await cli(root, ...args(name));
    }
    assert.equal(result.code, 0, result.stderr);
    const saved = JSON.parse(result.stdout).node;
    const current = await readNodeForEdit(adapter, `node-${name.toLowerCase()}`);
    assert.equal(current.body, `process ${name}`);
    assert.equal(saved.etag, contentEtag(current.raw));
    const version = (await adapter.history.pathVersions(`${name}/${name}.md`)).latest!;
    assert.ok(version);
    assert.equal(await adapter.history.read(version), current.raw);
    assert.deepEqual((await adapter.history.pathVersions(`${name}/${name}.md`)).first, version);
  }
  assert.equal((await adapter.history.changesInRange({ from: head })).length, 2);
});

test("append reuses a unique section after its nested content and preserves following sections", async (t) => {
  const before = "# Title\n\n```md\n## Notes\n```\n\n## Notes\nold\n\n### Child\nnested\n\n";
  const after = "## Next\nuntouched  \n\n# Higher\nlast\n";
  const { adapter } = await fixture(t, before + after);
  const saved = await appendNodeBody(adapter, "node-note", {
    heading: "Notes",
    body: "[Peer](node-peer)",
  });
  assert.equal(parseFrontmatter(saved.raw).body, before + "[Peer](../Peer/Peer.md)\n\n" + after);
  await appendNodeBody(adapter, "node-note", { heading: "Notes", body: "again" });
  const section = await readSection(adapter, "node-note", "Notes");
  assert.match(section.text, /nested\n\n\[Peer\].*\n\nagain\n\n$/);
  await appendNodeBody(adapter, "node-note", { body: "## Notes\nduplicate" });
  const raw = await adapter.readFile("Note/Note.md");
  await assert.rejects(
    appendNodeBody(adapter, "node-note", { heading: "Notes", body: "x" }),
    (error: unknown) => error instanceof NodeSectionError && error.code === "SECTION_AMBIGUOUS",
  );
  assert.equal(await adapter.readFile("Note/Note.md"), raw);
});

test("CLI adapter waits before execution but preserves CAS conflicts without retrying the action", async (t) => {
  const { adapter, tentRoot } = await fixture(t, "base");
  const current = await readNodeForEdit(adapter, "node-note");
  const cliAdapter = openTestFs(tentRoot, "cli");
  let acquired!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => (acquired = resolve));
  const held = new Promise<void>((resolve) => (release = resolve));
  const holder = adapter.withLock("mutation.lock", async () => {
    acquired();
    await held;
  });
  await ready;
  const stale = writeNodeDocument(cliAdapter, "node-note", {
    baseEtag: current.etag,
    body: "stale",
  });
  const rejected = assert.rejects(stale, /etag conflict/i);
  await adapter.writeFile("Note/Note.md", current.raw.replace("base", "external change"));
  release();
  await holder;
  await rejected;
  assert.match(await adapter.readFile("Note/Note.md"), /external change/);
});

test("cross-section reference definitions are canonicalized only inside the appended range", async (t) => {
  const { adapter } = await fixture(t);
  const uses = "## Uses\n[Peer][p]\n[untouched](node-peer)\n\n";
  const suffix = "## Last\nlast\n";
  const current = await readNodeForEdit(adapter, "node-note");
  await adapter.writeFile(
    "Note/Note.md",
    serializeFrontmatter(current.frontmatter, uses + "## Definitions\nexisting\n\n" + suffix),
  );
  const saved = await appendNodeBody(adapter, "node-note", {
    heading: "Definitions",
    body: '[p]: <node-peer#part> "Peer title"',
  });
  assert.equal(
    parseFrontmatter(saved.raw).body,
    uses + '## Definitions\nexisting\n\n[p]: <../Peer/Peer.md#part> "Peer title"\n\n' + suffix,
  );
  assert.equal(await adapter.history.read(saved.version!), saved.raw);
});

test("new reference uses preserve definitions outside the append range", async (t) => {
  const { adapter } = await fixture(t);
  const source = "## Uses\nold\n\n## Definitions\n[p]: node-peer\n";
  const current = await readNodeForEdit(adapter, "node-note");
  await adapter.writeFile("Note/Note.md", serializeFrontmatter(current.frontmatter, source));
  const definitions = await readSection(adapter, "node-note", "Definitions");
  const appended = await appendNodeBody(adapter, "node-note", {
    body: "[Peer][p]",
    heading: "Uses",
  });
  assert.equal(
    parseFrontmatter(appended.raw).body,
    "## Uses\nold\n\n[Peer][p]\n\n## Definitions\n[p]: node-peer\n",
  );
  assert.equal((await readSection(adapter, "node-note", "Definitions")).text, definitions.text);
  const more = await appendNodeBody(adapter, "node-note", {
    body: "[Peer again][p]",
    heading: "More",
  });
  assert.equal(
    parseFrontmatter(more.raw).body,
    parseFrontmatter(appended.raw).body + "\n## More\n\n[Peer again][p]\n",
  );
});

test("Core appended headings round-trip named and numeric entity spellings", async (t) => {
  const { adapter } = await fixture(t);
  const heading = "A &amp; B &#35; C &#x26; D & E";
  const saved = await appendNodeBody(adapter, "node-note", { heading, body: "plain" });
  assert.equal((await readNodeForEdit(adapter, "node-note")).raw, saved.raw);
  assert.equal(await adapter.history.read(saved.version!), saved.raw);
  const read = await readSection(adapter, "node-note", heading);
  assert.match(read.text, /A \\&amp; B \\&\\#35; C \\&\\#x26; D \\& E/);
  await assert.rejects(readSection(adapter, "node-note", "A & B # C & D & E"), /not found/);
});

test("append preserves generated and stale_after as arbitrary metadata", async (t) => {
  const { adapter } = await fixture(t, "original");
  const parsed = parseFrontmatter(await adapter.readFile("Note/Note.md"));
  const metadata = { generated: 17, stale_after: ["custom", false], owner: { team: "docs" } };
  await adapter.writeFile(
    "Note/Note.md",
    serializeFrontmatter({ ...parsed.data, ...metadata }, parsed.body, parsed.keyOrder),
  );
  const saved = await appendNodeBody(adapter, "node-note", { body: "added" });
  const data = parseFrontmatter(saved.raw).data;
  for (const [key, value] of Object.entries(metadata)) assert.deepEqual(data[key], value);
  assert.equal(parseFrontmatter(saved.raw).body, "original\n\nadded\n");
});
