import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { createNode } from "../src/core/ops.js";
import { readNodeForEdit } from "../src/core/node-query.js";
import { contentEtag } from "../src/core/etag.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { writeNodeDocument } from "../src/core/node-document-write.js";
import {
  appendNodeBody,
  readNodeSection,
  writeNodeSection,
  NodeSectionError,
} from "../src/core/node-lightwrite.js";
import { inspectNodeSync } from "../src/core/node-sync.js";
import { runNodeCommand, nodeHelpText } from "../src/cli/node-commands.js";
import { cli, extendTestLockWait, git } from "./helpers.js";

const lockTimeoutMessage =
  /^Tent mutation lock is still busy after waiting 8 seconds; wait for the other write to finish, then reread before retrying\.\nNext: tent node get node-note --full\n$/;

async function fixture(t: TestContext, body = "") {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "node-lightwrite-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  await scaffoldInWorkspace(new NodeFs(root), {
    name: "Lightwrite",
    nodes: [
      { id: "node-note", name: "Note", type: "prompt", body },
      { id: "node-peer", name: "Peer", type: "prompt", body: "peer" },
    ],
  });
  const tentRoot = path.join(root, ".tent");
  await git(tentRoot, "init", "--initial-branch=main");
  return { root, tentRoot, adapter: new NodeFs(tentRoot), peer: new NodeFs(tentRoot) };
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
  assert.equal(saved.etag, contentEtag(saved.raw));
  assert.ok(saved.version);
  assert.equal(await adapter.history.read(saved.version), saved.raw);
  assert.equal(
    (await readNodeSection(adapter, "node-note", "Notes *literally*")).text,
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
  const plan = await readNodeSection(adapter, "node-note", "Plan");
  assert.equal(plan.depth, 2);
  assert.equal(plan.text, body.slice(body.indexOf("## **Plan**"), body.indexOf("## Next")));
  assert.match(plan.sectionEtag, /^section:[a-f0-9]{24}$/);
  const next = await readNodeSection(adapter, "node-note", "Next");
  assert.equal(next.text, "## Next\nnext\n\n");
  assert.equal((await readNodeSection(adapter, "node-note", "Top")).depth, 1);
  await assert.rejects(
    readNodeSection(adapter, "node-note", "Fake"),
    (e) => e instanceof NodeSectionError && e.code === "SECTION_NOT_FOUND",
  );
  const current = await readNodeForEdit(adapter, "node-note");
  await writeNodeDocument(adapter, "node-note", {
    baseEtag: current.etag,
    body: body + "\n## Plan\nduplicate",
  });
  for (const request of [
    () => readNodeSection(adapter, "node-note", "Plan"),
    () =>
      writeNodeSection(adapter, "node-note", {
        heading: "Plan",
        baseEtag: plan.sectionEtag,
        body: "replacement",
      }),
  ])
    await assert.rejects(
      request(),
      (e) => e instanceof NodeSectionError && e.code === "SECTION_AMBIGUOUS",
    );
});

test("section CAS permits another section edit, preserves surrounding bytes and permits title rename/removal", async (t) => {
  const body = "intro  \n\n## First\noriginal\n\n## Second\n[keep](node-peer)\n";
  const { adapter } = await fixture(t, body);
  // Preserve an externally written uncanonicalized link outside the selected section.
  const original = await readNodeForEdit(adapter, "node-note");
  await adapter.writeFile("Note/Note.md", serializeFrontmatter(original.frontmatter, body));
  const first = await readNodeSection(adapter, "node-note", "First");
  const second = await readNodeSection(adapter, "node-note", "Second");
  const secondSaved = await writeNodeSection(adapter, "node-note", {
    heading: "Second",
    baseEtag: second.sectionEtag,
    body: "## Second\nchanged elsewhere\n",
  });
  assert.notEqual(secondSaved.etag, original.etag);
  const saved = await writeNodeSection(adapter, "node-note", {
    heading: "First",
    baseEtag: first.sectionEtag,
    body: "## Renamed\n[new](node-peer)\n\n",
  });
  assert.equal(
    parseFrontmatter(saved.raw).body,
    "intro  \n\n## Renamed\n[new](../Peer/Peer.md)\n\n## Second\nchanged elsewhere\n",
  );
  assert.equal(saved.etag, contentEtag(saved.raw));
  assert.equal(await adapter.history.read(saved.version!), saved.raw);
  await assert.rejects(readNodeSection(adapter, "node-note", "First"), /not found/);
  const renamed = await readNodeSection(adapter, "node-note", "Renamed");
  const removed = await writeNodeSection(adapter, "node-note", {
    heading: "Renamed",
    baseEtag: renamed.sectionEtag,
    body: "",
  });
  assert.equal(parseFrontmatter(removed.raw).body, "intro  \n\n## Second\nchanged elsewhere\n");
});

test("section write leaves other body bytes exact and rejects changes within its own nested section", async (t) => {
  const body = "## A\nalpha\n\n### Child\nchild\n\n## B\n[raw](node-peer)\n";
  const { adapter, peer } = await fixture(t, body);
  const current = await readNodeForEdit(adapter, "node-note");
  await adapter.writeFile("Note/Note.md", serializeFrontmatter(current.frontmatter, body));
  const a = await readNodeSection(adapter, "node-note", "A");
  const saved = await writeNodeSection(peer, "node-note", {
    heading: "A",
    baseEtag: a.sectionEtag,
    body: "## A\nnew\n\n### Child\nchanged\n\n",
  });
  assert.equal(
    parseFrontmatter(saved.raw).body,
    "## A\nnew\n\n### Child\nchanged\n\n## B\n[raw](node-peer)\n",
  );
  await assert.rejects(
    writeNodeSection(adapter, "node-note", { heading: "A", baseEtag: a.sectionEtag, body: a.text }),
    (e) => e instanceof NodeSectionError && e.code === "SECTION_ETAG_CONFLICT",
  );
  await assert.rejects(
    writeNodeSection(adapter, "node-note", { heading: "A", baseEtag: saved.etag, body: "x" }),
    /Section ETag conflict/,
  );
  await assert.rejects(
    writeNodeSection(adapter, "node-note", {
      heading: "Missing",
      baseEtag: a.sectionEtag,
      body: "x",
    }),
    /not found/,
  );
  assert.equal((await readNodeForEdit(adapter, "node-note")).raw, saved.raw);
});

test("section replacement without a final newline keeps the next ATX and Setext heading intact", async (t) => {
  const { adapter } = await fixture(
    t,
    "before\n\n## A\nalpha\n\n## B\nbeta\n\nSetext\n------\nsetext\n",
  );
  const a = await readNodeSection(adapter, "node-note", "A");
  const saved = await writeNodeSection(adapter, "node-note", {
    heading: "A",
    baseEtag: a.sectionEtag,
    body: "## A\nchanged",
  });
  assert.equal(
    parseFrontmatter(saved.raw).body,
    "before\n\n## A\nchanged\n\n## B\nbeta\n\nSetext\n------\nsetext\n",
  );
  const b = await readNodeSection(adapter, "node-note", "B");
  await writeNodeSection(adapter, "node-note", {
    heading: "B",
    baseEtag: b.sectionEtag,
    body: "replacement paragraph",
  });
  assert.equal(
    (await readNodeSection(adapter, "node-note", "Setext")).text,
    "Setext\n------\nsetext\n",
  );
  const currentA = await readNodeSection(adapter, "node-note", "A");
  await writeNodeSection(adapter, "node-note", {
    heading: "A",
    baseEtag: currentA.sectionEtag,
    body: "",
  });
  assert.equal(
    (await readNodeForEdit(adapter, "node-note")).body,
    "before\n\nSetext\n------\nsetext\n",
  );
});

test("lightweight ordinary saves retain material behind and standard material validation", async (t) => {
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
  const before = await inspectNodeSync(adapter, id);
  const section = await readNodeSection(adapter, id, "Evidence");
  await fs.writeFile(material, "v2");
  await appendNodeBody(adapter, id, { body: "## Notes\nextra" });
  assert.equal((await inspectNodeSync(adapter, id)).state, "behind");
  await writeNodeSection(adapter, id, {
    heading: "Evidence",
    baseEtag: section.sectionEtag,
    body: "## Evidence\nupdated\n\n",
  });
  const after = await inspectNodeSync(adapter, id);
  assert.equal(after.state, "behind");
  assert.equal(after.materials[0]!.recordedVersion, before.materials[0]!.recordedVersion);
  const live = await readNodeForEdit(adapter, id);
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

test("real CLI append times out without changing bytes or history, then one caller retry writes once", async (t) => {
  const { root, tentRoot, adapter } = await fixture(t, "start");
  const before = await readNodeForEdit(adapter, "node-note", { capture: true });
  const history = await git(tentRoot, "rev-list", "--all");
  const head = (await git(tentRoot, "rev-parse", "HEAD")).trim();
  let acquired!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => (acquired = resolve));
  const held = new Promise<void>((resolve) => (release = resolve));
  const holder = adapter.withLock("mutation.lock", async () => {
    acquired();
    await held;
  });
  const payload = "caller retry payload";
  try {
    await ready;
    const start = performance.now();
    const rejected = await cli(root, "node", "append", "node-note", "--body", payload, "--json");
    assert.equal(rejected.code, 1, rejected.stderr);
    assert.match(rejected.stderr, lockTimeoutMessage);
    assert.equal(rejected.stdout, "");
    assert.ok(performance.now() - start >= 8_000, "the real CLI keeps its eight-second wait");
    assert.equal(await adapter.readFile("Note/Note.md"), before.raw);
    assert.equal((await git(tentRoot, "rev-parse", "HEAD")).trim(), head);
    assert.equal(await git(tentRoot, "rev-list", "--all"), history);
  } finally {
    release();
    await holder;
  }
  assert.equal(await adapter.readFile("Note/Note.md"), before.raw);
  assert.equal(await git(tentRoot, "rev-list", "--all"), history);

  // A new caller invocation, after the holder releases; the failed action is never retried inside Tent.
  const retried = await cli(root, "node", "append", "node-note", "--body", payload, "--json");
  assert.equal(retried.code, 0, retried.stderr);
  const saved = JSON.parse(retried.stdout);
  const current = await readNodeForEdit(adapter, "node-note");
  assert.equal(current.body, `start\n\n${payload}\n`);
  assert.equal(saved.etag, contentEtag(current.raw));
  assert.ok(saved.version);
  assert.equal(await adapter.history.read(saved.version), current.raw);
  assert.equal(saved.version.commit, (await git(tentRoot, "rev-parse", "HEAD")).trim());
  assert.equal((await git(tentRoot, "rev-list", "--count", `${head}..HEAD`)).trim(), "1");
});

test("real CLI processes queue concurrent append and section stdin edit reports captured version", async (t) => {
  const { root, tentRoot, adapter } = await fixture(t, "start");
  await readNodeForEdit(adapter, "node-note", { capture: true });
  const head = (await git(tentRoot, "rev-parse", "HEAD")).trim();
  const payloads = ["process one", "process two"];
  const results = await Promise.all(
    payloads.map((body) => cli(root, "node", "append", "node-note", "--body", body, "--json")),
  );
  t.diagnostic(
    `Concurrent CLI initial exit codes: ${results.map((result) => result.code).join(", ")}`,
  );
  assert.ok(results.some((result) => result.code === 0));
  for (let i = 0; i < results.length; i++) {
    let result = results[i]!;
    if (result.code !== 0) {
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, lockTimeoutMessage);
      assert.ok(!(await readNodeForEdit(adapter, "node-note")).body.includes(payloads[i]!));
      // The acquisition deadline can expire on a loaded host. Both contenders have
      // settled, so one caller retry must append the previously rejected input once.
      result = await cli(root, "node", "append", "node-note", "--body", payloads[i]!, "--json");
    }
    assert.equal(result.code, 0, result.stderr);
    const saved = JSON.parse(result.stdout);
    assert.match(saved.etag, /^[a-f0-9]{24}$/);
    assert.ok(saved.version);
    const captured = await adapter.history.read(saved.version);
    assert.equal(saved.etag, contentEtag(captured));
    assert.equal(parseFrontmatter(captured).body.split(payloads[i]!).length, 2);
  }
  const body = (await readNodeForEdit(adapter, "node-note")).body;
  for (const payload of payloads) assert.equal(body.split(payload).length, 2);
  assert.equal((await git(tentRoot, "rev-list", "--count", `${head}..HEAD`)).trim(), "2");
  const appended = await runNodeCommand(
    "append",
    ["node-note", "--heading", "Summary", "--body", "-"],
    { workspace: root, json: true, stdin: "from stdin\n" },
  );
  assert.equal(appended.exitCode, 0, appended.stderr);
  const selected = await cli(
    root,
    "node",
    "get-section",
    "node-note",
    "--heading",
    "Summary",
    "--json",
  );
  assert.equal(selected.code, 0, selected.stderr);
  const section = JSON.parse(selected.stdout);
  const changed = await runNodeCommand(
    "write-section",
    ["node-note", "--heading", "Summary", "--base-etag", section.sectionEtag, "--body", "-"],
    { workspace: root, json: true, stdin: "## New summary\nreplaced\n" },
  );
  assert.equal(changed.exitCode, 0, changed.stderr);
  assert.ok(JSON.parse(changed.stdout).version);
  const stale = await cli(
    root,
    "node",
    "write-section",
    "node-note",
    "--heading",
    "New summary",
    "--base-etag",
    section.sectionEtag,
    "--body",
    "overwrite",
    "--json",
  );
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /Section ETag conflict/);
  for (const sub of ["append", "get-section", "write-section"])
    assert.match(nodeHelpText(sub), new RegExp(`tent node ${sub}`));
  const invalid = await runNodeCommand(
    "append",
    ["node-note", "--body", "x", "--base-etag", "irrelevant"],
    { workspace: root },
  );
  assert.equal(invalid.exitCode, 1);
  for (const sub of ["create", "write", "get"]) {
    const scoped = await runNodeCommand(sub, ["node-note", "--heading", "invalid"], {
      workspace: root,
    });
    assert.equal(scoped.exitCode, 1);
    assert.match(scoped.stderr, /--heading is only valid/);
  }
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
  const section = await readNodeSection(adapter, "node-note", "Notes");
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
  const cliAdapter = new NodeFs(tentRoot, "cli");
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

test("cross-section reference definitions are canonicalized only inside the appended or replaced range", async (t) => {
  const { adapter } = await fixture(t);
  const writeRawBody = async (body: string) => {
    const current = await readNodeForEdit(adapter, "node-note");
    await adapter.writeFile("Note/Note.md", serializeFrontmatter(current.frontmatter, body));
  };
  const uses = "## Uses\n[Peer][p]\n[untouched](node-peer)\n";
  await writeRawBody(uses);
  const appended = await appendNodeBody(adapter, "node-note", {
    body: '[p]: <node-peer#part> "Peer title"',
  });
  assert.equal(
    parseFrontmatter(appended.raw).body,
    uses + '\n[p]: <../Peer/Peer.md#part> "Peer title"\n',
  );
  const prefix = uses + "\n";
  const suffix = "## Last\nlast\n";
  await writeRawBody(prefix + "## Definitions\n[p]: https://example.invalid\n\n" + suffix);
  const observedUses = await readNodeSection(adapter, "node-note", "Uses");
  const definitions = await readNodeSection(adapter, "node-note", "Definitions");
  const replaced = await writeNodeSection(adapter, "node-note", {
    heading: "Definitions",
    baseEtag: definitions.sectionEtag,
    body: "## Definitions\n[p]: node-peer",
  });
  assert.equal(
    parseFrontmatter(replaced.raw).body,
    prefix + "## Definitions\n[p]: ../Peer/Peer.md\n\n" + suffix,
  );
  assert.equal(
    (await readNodeSection(adapter, "node-note", "Uses")).sectionEtag,
    observedUses.sectionEtag,
  );
  assert.equal(await adapter.history.read(replaced.version!), replaced.raw);
});

test("new reference uses preserve definitions outside the append or replacement range", async (t) => {
  const { adapter } = await fixture(t);
  const source = "## Uses\nold\n\n## Definitions\n[p]: node-peer\n";
  const current = await readNodeForEdit(adapter, "node-note");
  await adapter.writeFile("Note/Note.md", serializeFrontmatter(current.frontmatter, source));
  const uses = await readNodeSection(adapter, "node-note", "Uses");
  const definitions = await readNodeSection(adapter, "node-note", "Definitions");
  const replaced = await writeNodeSection(adapter, "node-note", {
    heading: "Uses",
    baseEtag: uses.sectionEtag,
    body: "## Uses\n[Peer][p]",
  });
  assert.equal(
    parseFrontmatter(replaced.raw).body,
    "## Uses\n[Peer][p]\n\n## Definitions\n[p]: node-peer\n",
  );
  assert.equal(
    (await readNodeSection(adapter, "node-note", "Definitions")).sectionEtag,
    definitions.sectionEtag,
  );
  const appended = await appendNodeBody(adapter, "node-note", {
    body: "[Peer again][p]",
    heading: "More",
  });
  assert.equal(
    parseFrontmatter(appended.raw).body,
    "## Uses\n[Peer][p]\n\n## Definitions\n[p]: node-peer\n\n## More\n\n[Peer again][p]\n",
  );
});

test("plain appended heading text round-trips named and numeric entity spellings through CLI", async (t) => {
  const { root, adapter } = await fixture(t);
  const heading = "A &amp; B &#35; C &#x26; D & E";
  const result = await runNodeCommand(
    "append",
    ["node-note", "--heading", heading, "--body", "plain", "--json"],
    { workspace: root },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const section = await runNodeCommand(
    "get-section",
    ["node-note", "--heading", heading, "--json"],
    { workspace: root },
  );
  assert.equal(section.exitCode, 0, section.stderr);
  assert.equal(JSON.parse(section.stdout).heading, heading);
  const read = await readNodeSection(adapter, "node-note", heading);
  assert.match(read.text, /A \\&amp; B \\&\\#35; C \\&\\#x26; D \\& E/);
  await assert.rejects(readNodeSection(adapter, "node-note", "A & B # C & D & E"), /not found/);
});
