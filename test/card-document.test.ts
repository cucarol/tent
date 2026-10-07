import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { initializeTentWorkspace } from "../src/fs/workspace-init.js";
import {
  createCardDocument,
  readCardDocument,
  takeCardDocument,
  watchCardDocuments,
  listCardDocuments,
  moveCardDocument,
  deprecateCardDocument,
  inspectReceivedCardSourceChanges,
} from "../src/core/card-document.js";
import { createRoleContext, editRoleContext } from "../src/core/role-context.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { renameNode } from "../src/core/rename-ops.js";
import { contentEtag } from "../src/core/etag.js";
import type { DocumentVersion } from "../src/core/git-history.js";
import { git } from "./helpers.js";
import { runCardCommand } from "../src/cli/card-commands.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { writeNodeDocument } from "../src/core/node-document-write.js";
import { linkNodeOutput, confirmNodeSync } from "../src/core/node-sync.js";
import { readOutputActivity } from "../src/core/card-progress.js";

async function fixture(t: TestContext) {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "card-document-"));
  t.after(async () => {
    assert.equal(path.dirname(root), scratch);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });
  await git(root, "init");
  const adapter = new NodeFs(root);
  const node = "\uFEFF---\r\nid: node-main\r\ntype: prompt\r\n---\r\nexact fact\r\n";
  await adapter.writeFile("Main/Main.md", node);
  await adapter.writeFile("Other/Other.md", "---\nid: node-other\ntype: prompt\n---\nnot selected");
  await createRoleContext(adapter, { roleId: "role-a", title: "A", body: "direction A" });
  await createRoleContext(adapter, { roleId: "role-b", title: "B", body: "direction B" });
  return { root, adapter, node };
}
const code = (expected: string) => (error: unknown) =>
  (error as { code?: string }).code === expected;

test("take completes an interrupted reception from consumed files and pending Git exactly once", async (t) => {
  const { adapter, root } = await fixture(t);
  for (const roleId of [undefined, "role-a"]) {
    const card = await createCardDocument(adapter, {
      cardId: roleId ? "card-recoverrole" : "card-recoveropen",
      prompt: "Keep the original input",
      ...(roleId ? { target: roleId } : {}),
    });
    const capture = adapter.history.captureUnlocked.bind(adapter.history);
    adapter.history.captureUnlocked = async (changes, metadata) => {
      if (metadata?.operation === "card.take") throw new Error("interrupted before publication");
      return capture(changes, metadata);
    };
    await assert.rejects(
      takeCardDocument(adapter, card.cardId, roleId),
      /interrupted before publication/,
    );
    adapter.history.captureUnlocked = capture;
    const savedBytes = await adapter.readFile(card.path);
    assert.equal(parseFrontmatter(savedBytes).data.state, "consumed");
    assert.equal(parseFrontmatter(await adapter.history.read(card.version)).data.state, "pending");
    assert.equal(
      ((await readCardDocument(adapter, card.cardId)) as any).diagnostic.code,
      "STATE_CHANGED",
    );
    if (roleId)
      assert.equal((await watchCardDocuments(adapter, roleId, 0))[0]!.cardId, card.cardId);
    const taken = (await takeCardDocument(adapter, card.cardId, roleId)) as Record<string, any>;
    assert.equal(taken.replayed, false);
    assert.equal(await adapter.history.read(taken.version!), savedBytes);
    assert.equal(await adapter.readFile(card.path), savedBytes);
    if (roleId) assert.deepEqual(await watchCardDocuments(adapter, roleId, 0), []);
    const head = await adapter.history.currentCommit();
    assert.equal(
      ((await takeCardDocument(adapter, card.cardId, roleId)) as Record<string, any>).replayed,
      true,
    );
    assert.equal(await adapter.history.currentCommit(), head);
  }
  // The fixture contains two uncaptured source Nodes; retained Cards have no staged deletion.
  assert.equal((await git(root, "diff", "--cached", "--name-only")).trim(), "");
});

test("interrupted reception recovery rejects simultaneous status, target and input changes", async (t) => {
  const { adapter } = await fixture(t);
  const card = await createCardDocument(adapter, {
    cardId: "card-recoverconflict",
    prompt: "original",
  });
  const original = await adapter.readFile(card.path);
  for (const [changes, expected] of [
    [{ state: "consumed", receivedBy: "role-a", status: "deprecated" }, "STATE_CHANGED"],
    [{ state: "consumed", receivedBy: "role-a", target: "role-a" }, "STATE_CHANGED"],
  ] as const) {
    const parsed = parseFrontmatter(original);
    await adapter.writeFile(
      card.path,
      serializeFrontmatter({ ...parsed.data, ...changes }, parsed.body),
    );
    await assert.rejects(takeCardDocument(adapter, card.cardId, "role-a"), code(expected));
  }
  await adapter.writeFile(
    card.path,
    original
      .replace("state: pending", "state: consumed\nreceivedBy: role-a")
      .replace("original", "changed"),
  );
  await assert.rejects(takeCardDocument(adapter, card.cardId, "role-a"), code("INPUT_CHANGED"));
  assert.equal((await adapter.history.pathVersions(card.path)).latest!.commit, card.version.commit);
});

test("Card progress counts only outputs explicitly responding to this Card", async (t) => {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "card-progress-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  const workspace = path.join(root, "workspace");
  await initializeTentWorkspace(workspace);
  const adapter = new NodeFs(path.join(workspace, ".tent"));
  await adapter.writeFile(
    "Main/Main.md",
    serializeFrontmatter({ id: "node-main", type: "goal" }, "First goal"),
  );
  await adapter.writeFile(
    "Other/Other.md",
    serializeFrontmatter({ id: "node-other", type: "goal" }, "Second goal"),
  );
  await fs.writeFile(path.join(workspace, "result.txt"), "result");
  const oldOutput = await linkNodeOutput(adapter, "node-other", { resource: "result.txt" });
  const card = await createCardDocument(adapter, {
    cardId: "card-progress",
    prompt: "Read both goals.",
    sources: [
      { resource: "/Main/Main.md" },
      { resource: "/Other/Other.md" },
      { resource: "/Main/Main.md" },
    ],
  });
  assert.equal(card.progress, "pending");
  assert.equal(card.totalGoalCount, 2);
  assert.equal(card.goalCount, 0);
  const taken = (await takeCardDocument(adapter, card.cardId)) as Record<string, unknown>;
  assert.equal(taken.progress, "received-no-output");
  const raw = await adapter.readFile(card.path);
  // A later ordinary save of a preexisting output cannot stand in for confirmation.
  const oldPath = `Other/${oldOutput.path.split("/").at(-1)}/${oldOutput.path.split("/").at(-1)}.md`;
  const oldRaw = await adapter.readFile(oldPath);
  await adapter.writeFile(oldPath, oldRaw + "\nordinary edit");
  await adapter.history.captureUnlocked([{ path: oldPath, raw: oldRaw + "\nordinary edit" }], {
    operation: "node.document-write",
  });
  assert.equal(
    ((await readCardDocument(adapter, card.cardId)) as Record<string, unknown>).goalCount,
    0,
  );
  const output = await linkNodeOutput(adapter, "node-main", {
    resource: "result.txt",
    cardId: card.cardId,
  });
  assert.equal(output.cardId, card.cardId);
  const outputRaw = await adapter.readFile(`${output.path}/${output.path.split("/").at(-1)}.md`);
  assert.deepEqual(parseFrontmatter(outputRaw).data.sources, [
    { resource: "/cards/card-progress.md" },
  ]);
  const partial = (await readCardDocument(adapter, card.cardId)) as Record<string, unknown>;
  assert.equal(partial.progress, "received-no-output");
  assert.equal(partial.goalCount, 1);
  assert.equal(partial.totalGoalCount, 2);
  assert.deepEqual(partial.outputNodeIds, [output.nodeId]);
  const cli = await runCardCommand("show", [card.cardId], { workspace, json: true });
  assert.equal(cli.exitCode, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).goalCount, 1);
  assert.equal(JSON.parse(cli.stdout).totalGoalCount, 2);
  const cliList = await runCardCommand("list", [], { workspace });
  assert.equal(cliList.exitCode, 0, cliList.stderr);
  assert.match(cliList.stdout, /1\/2/);
  await renameNode(
    { fs: adapter, clock: { now: () => "test" }, tentName: "test" },
    "node-main",
    "Moved",
  );
  assert.equal(
    ((await readCardDocument(adapter, card.cardId)) as Record<string, unknown>).goalCount,
    1,
  );
  await confirmNodeSync(adapter, oldOutput.nodeId, {
    baseEtag: contentEtag(await adapter.readFile(oldPath)),
  });
  assert.equal(
    ((await readCardDocument(adapter, card.cardId)) as Record<string, unknown>).goalCount,
    1,
    "confirming an old unrelated output does not complete this Card",
  );
  await writeNodeDocument(adapter, oldOutput.nodeId, {
    baseEtag: contentEtag(await adapter.readFile(oldPath)),
    frontmatter: { sources: [{ resource: "/cards/card-progress.md" }] },
  });
  const completed = (await readCardDocument(adapter, card.cardId)) as Record<string, unknown>;
  assert.equal(completed.progress, "has-output");
  assert.equal(completed.goalCount, 2);
  const listed = (await listCardDocuments(adapter)).items.find(
    (item) => item.cardId === card.cardId,
  )!;
  assert.equal(listed.progress, completed.progress);
  assert.deepEqual(listed.outputNodeIds, completed.outputNodeIds);
  assert.equal(await adapter.readFile(card.path), raw);
  assert.equal(parseFrontmatter(raw).data.progress, undefined);
  await adapter.remove("Moved");
  assert.equal(
    ((await readCardDocument(adapter, card.cardId)) as Record<string, unknown>).goalCount,
    1,
  );
  const confirmedCard = await createCardDocument(adapter, {
    cardId: "card-confirmwrite",
    prompt: "Verify the second goal.",
    sources: [{ resource: "/Other/Other.md" }],
  });
  assert.equal(
    ((await takeCardDocument(adapter, confirmedCard.cardId)) as Record<string, unknown>).goalCount,
    0,
  );
  await writeNodeDocument(adapter, oldOutput.nodeId, {
    baseEtag: contentEtag(await adapter.readFile(oldPath)),
    confirm: true,
    by: "human:cuca",
  });
  assert.equal(
    ((await readCardDocument(adapter, confirmedCard.cardId)) as Record<string, unknown>).progress,
    "received-no-output",
  );
  await assert.rejects(
    linkNodeOutput(adapter, "node-other", { resource: "result.txt" }),
    /Incomplete received Cards.*--card/,
  );
  const linked = await runNodeCommand(
    "link-output",
    ["node-other", "--resource", "result.txt", "--card", confirmedCard.cardId],
    { workspace, json: true },
  );
  assert.equal(linked.exitCode, 0, linked.stderr);
  const second = JSON.parse(linked.stdout);
  assert.deepEqual(
    ((await readCardDocument(adapter, confirmedCard.cardId)) as Record<string, unknown>)
      .outputNodeIds,
    [second.nodeId],
  );
  assert.equal(
    ((await readCardDocument(adapter, card.cardId)) as Record<string, unknown>).goalCount,
    1,
  );
  await adapter.writeFile(card.path, raw + "\nmanual input edit");
  const independent = await linkNodeOutput(adapter, "node-other", { resource: "result.txt" });
  assert.deepEqual(
    parseFrontmatter(
      await adapter.readFile(`${independent.path}/${independent.path.split("/").at(-1)}.md`),
    ).data.sources ?? [],
    [],
    "an invalid received Card is not an inference candidate",
  );
  await adapter.writeFile(
    "Notes/Notes.md",
    serializeFrontmatter({ id: "node-notes", type: "prompt-spec" }, "Notes"),
  );
  const plain = await createCardDocument(adapter, {
    cardId: "card-nogoal",
    prompt: "Read the notes.",
    sources: [{ resource: "/Notes/Notes.md" }],
  });
  assert.equal(plain.progress, null);
  assert.equal(
    ((await takeCardDocument(adapter, plain.cardId)) as Record<string, unknown>).progress,
    null,
  );
});

test("automatic output attribution requires the receiving Role and returns the selected Card", async (t) => {
  const { adapter, root } = await fixture(t);
  await adapter.writeFile(
    "Main/Main.md",
    serializeFrontmatter({ id: "node-main", type: "goal" }, "Goal"),
  );
  const card = await createCardDocument(adapter, {
    cardId: "card-roleoutput",
    prompt: "Implement the goal",
    sources: [{ resource: "/Main/Main.md" }],
    target: "role-a",
  });
  await takeCardDocument(adapter, card.cardId, "role-a");
  const input = { resource: "https://example.org/result" };
  for (const options of [{}, { roleId: "role-b" }, { by: "role-a" }])
    await assert.rejects(linkNodeOutput(adapter, "node-main", { ...input, ...options }), /--card/);
  assert.equal((await adapter.listDir("Main")).filter((entry) => entry.isDir).length, 0);
  const linked = await linkNodeOutput(adapter, "node-main", { ...input, roleId: "role-a" });
  assert.equal(linked.cardId, card.cardId);
  assert.equal(((await readCardDocument(adapter, card.cardId)) as any).progress, "has-output");
  const next = await createCardDocument(adapter, {
    cardId: "card-roleoutputnext",
    prompt: "Implement the next response",
    sources: [{ resource: "/Main/Main.md" }],
    target: "role-a",
  });
  await takeCardDocument(adapter, next.cardId, "role-a");
  const last = await createCardDocument(adapter, {
    cardId: "card-roleoutputlast",
    prompt: "Implement another response",
    sources: [{ resource: "/Main/Main.md" }],
    target: "role-a",
  });
  await takeCardDocument(adapter, last.cardId, "role-a");
  await assert.rejects(
    linkNodeOutput(adapter, "node-main", { ...input, roleId: "role-a" }),
    /Multiple incomplete Cards.*--card/,
  );
  const explicit = await linkNodeOutput(adapter, "node-main", {
    ...input,
    roleId: "role-b",
    cardId: next.cardId,
  });
  assert.equal(explicit.cardId, next.cardId, "explicit Card choice can cross Role boundaries");
  const head = await adapter.history.currentCommit();
  assert.ok(head);
  assert.equal((await git(root, "diff", "--cached", "--name-only")).trim(), "");
});

test("behind responses retract Card completion and output activity without changing Card bytes", async (t) => {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "card-review-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  const workspace = path.join(root, "workspace");
  await initializeTentWorkspace(workspace);
  const adapter = new NodeFs(path.join(workspace, ".tent"));
  await adapter.writeFile(
    "Goal/Goal.md",
    serializeFrontmatter({ id: "node-goal", type: "goal" }, "Goal"),
  );
  await createRoleContext(adapter, { roleId: "role-a", title: "A", body: "direction" });
  const card = await createCardDocument(adapter, {
    cardId: "card-review",
    prompt: "Implement and review the goal",
    sources: [{ resource: "/Goal/Goal.md" }],
    target: "role-a",
  });
  await takeCardDocument(adapter, card.cardId, "role-a");
  await fs.writeFile(path.join(workspace, "result.txt"), "first");
  const cli = await runNodeCommand(
    "link-output",
    ["node-goal", "--resource", "result.txt", "--role", "role-a"],
    { workspace, json: true },
  );
  assert.equal(cli.exitCode, 0, cli.stderr);
  const output = JSON.parse(cli.stdout);
  assert.equal(output.cardId, card.cardId);
  const outputPath = `${output.path}/${output.path.split("/").at(-1)}.md`;
  await confirmNodeSync(adapter, output.nodeId, {
    baseEtag: contentEtag(await adapter.readFile(outputPath)),
    by: "human:cuca",
  });
  const cardRaw = await adapter.readFile(card.path);
  assert.equal(((await readCardDocument(adapter, card.cardId)) as any).progress, "has-output");
  assert.ok((await readOutputActivity(adapter)).has(output.nodeId));
  await fs.writeFile(path.join(workspace, "result.txt"), "changed");
  const head = await adapter.history.currentCommit();
  const behind = (await readCardDocument(adapter, card.cardId)) as any;
  assert.equal(behind.progress, "needs-review");
  assert.equal(behind.goalCount, 0);
  assert.deepEqual(behind.outputNodeIds, []);
  assert.equal(behind.reviewGoalCount, 1);
  assert.deepEqual(behind.reviewOutputNodeIds, [output.nodeId]);
  assert.ok(!(await readOutputActivity(adapter)).has(output.nodeId));
  assert.equal(await adapter.history.currentCommit(), head);
  assert.equal(await adapter.readFile(card.path), cardRaw);
  await assert.rejects(
    linkNodeOutput(adapter, "node-goal", { resource: "result.txt", roleId: "role-b" }),
    /--card/,
  );
  await confirmNodeSync(adapter, output.nodeId, {
    baseEtag: contentEtag(await adapter.readFile(outputPath)),
    by: "human:cuca",
  });
  assert.equal(((await readCardDocument(adapter, card.cardId)) as any).progress, "has-output");
  assert.ok((await readOutputActivity(adapter)).has(output.nodeId));
});

test("Card source inspection needs no Git when no published Card was received", async (t) => {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "card-nohistory-"));
  t.after(async () => {
    assert.equal(path.dirname(root), scratch);
    await fs.rm(root, { recursive: true, force: true });
  });
  const adapter = new NodeFs(root);
  await adapter.mkdir("cards");
  assert.deepEqual(await inspectReceivedCardSourceChanges(adapter), { items: [], diagnostics: [] });
  await adapter.writeFile(
    "cards/card-draft.md",
    serializeFrontmatter(
      { type: "card", id: "card-draft", schemaVersion: 3, state: "pending", sources: [] },
      "not ready",
    ),
  );
  assert.deepEqual(await inspectReceivedCardSourceChanges(adapter), { items: [], diagnostics: [] });
});

test("Card deprecation preserves input and reception, checks CAS, and replays without capture", async (t) => {
  const { adapter } = await fixture(t);
  const created = await createCardDocument(adapter, {
    prompt: "Read the Node.",
    sources: [{ resource: "node-main" }],
    target: "role-a",
  });
  const taken = await takeCardDocument(adapter, created.cardId, "role-a");
  const before = parseFrontmatter(await adapter.readFile(created.path));
  const head = await adapter.history.currentCommit();
  await assert.rejects(
    () => deprecateCardDocument(adapter, created.cardId, created.etag),
    code("STATE_CHANGED"),
  );
  assert.equal(await adapter.history.currentCommit(), head);
  const deprecated = await deprecateCardDocument(adapter, created.cardId, taken.etag);
  const after = parseFrontmatter(await adapter.readFile(created.path));
  assert.deepEqual(after.data, { ...before.data, status: "deprecated" });
  assert.equal(after.body, before.body);
  assert.equal(deprecated.status, "deprecated");
  assert.equal(deprecated.state, "consumed");
  const cancelledHead = await adapter.history.currentCommit();
  assert.deepEqual(
    await deprecateCardDocument(adapter, created.cardId, deprecated.etag),
    deprecated,
  );
  assert.equal(await adapter.history.currentCommit(), cancelledHead);
  assert.equal((await listCardDocuments(adapter, { roleId: "role-a" })).items.length, 0);
  assert.equal(
    (
      await listCardDocuments(adapter, {
        roleId: "role-a",
        state: "consumed",
        includeDeprecated: true,
      })
    ).items.length,
    1,
  );
  const replay = await takeCardDocument(adapter, created.cardId, "role-a");
  assert.equal(replay.text, before.body);
  assert.equal((replay as Record<string, unknown>).replayed, true);
  assert.match(String((replay as Record<string, unknown>).notice), /deprecated/);
  await assert.rejects(
    () => takeCardDocument(adapter, created.cardId, "role-b"),
    code("RECEPTION_CONFLICT"),
  );
});

test("Card deprecation rejects manual input and management edits without changing bytes or history", async (t) => {
  const { adapter } = await fixture(t);
  const card = await createCardDocument(adapter, { prompt: "fixed input" });
  const original = await adapter.readFile(card.path),
    head = await adapter.history.currentCommit();
  for (const [raw, expected] of [
    [original.replace("fixed input", "edited input"), "INPUT_CHANGED"],
    [original.replace("state: pending", "state: consumed"), "STATE_CHANGED"],
    [original.replace("state: pending", "state: pending\nstatus: deprecated"), "STATE_CHANGED"],
  ]) {
    await adapter.writeFile(card.path, raw!);
    await assert.rejects(
      () => deprecateCardDocument(adapter, card.cardId, contentEtag(raw!)),
      code(expected!),
    );
    assert.equal(await adapter.readFile(card.path), raw);
    assert.equal(await adapter.history.currentCommit(), head);
  }
});

test("Deprecated Card reads and takes expose live Node, Role and published Card references", async (t) => {
  const { adapter } = await fixture(t);
  const card = await createCardDocument(adapter, {
    cardId: "card-cancelled",
    prompt: "original input",
    target: "role-a",
  });
  await adapter.writeFile(
    "Other/Other.md",
    serializeFrontmatter(
      { id: "node-other", type: "prompt", sources: [{ resource: "/cards/card-cancelled.md" }] },
      "see task",
    ),
  );
  await createRoleContext(adapter, {
    roleId: "role-reference",
    title: "Reference",
    body: "[task](../cards/card-cancelled.md)",
  });
  await createCardDocument(adapter, {
    cardId: "card-reference",
    prompt: "[task](./card-cancelled.md)",
  });
  const old = await createCardDocument(adapter, {
    cardId: "card-oldref",
    prompt: "[task](./card-cancelled.md)",
  });
  await deprecateCardDocument(adapter, old.cardId, old.etag);
  await deprecateCardDocument(adapter, card.cardId, card.etag);
  const shown = (await readCardDocument(adapter, card.cardId)) as Record<string, unknown>;
  assert.equal(shown.text, "original input");
  assert.match(String(shown.notice), /deprecated/);
  assert.deepEqual(shown.currentReferences, [
    { kind: "node", id: "node-other", path: "Other/Other.md" },
    { kind: "role", id: "role-reference", path: "roles/role-reference.md" },
    { kind: "card", id: "card-reference", path: "cards/card-reference.md" },
  ]);
  await assert.rejects(
    () => takeCardDocument(adapter, card.cardId, undefined),
    code("RECEPTION_CONFLICT"),
  );
  const taken = (await takeCardDocument(adapter, card.cardId, "role-a")) as Record<string, unknown>;
  assert.equal(taken.state, "consumed");
  assert.deepEqual(taken.currentReferences, shown.currentReferences);
});

test("Received Card source inspection compares live content, follows Node identity and never writes", async (t) => {
  const { root, adapter, node } = await fixture(t);
  const received = await createCardDocument(adapter, {
    cardId: "card-received",
    prompt: "Read node",
    sources: [
      { resource: "node-main" },
      { resource: "/roles/role-a.md" },
      { resource: "https://example.invalid/requirements" },
    ],
    target: "role-a",
  });
  const receivedPage = await takeCardDocument(adapter, received.cardId, "role-a");
  const pending = await createCardDocument(adapter, {
    cardId: "card-pendingsource",
    prompt: "Read node",
    sources: [{ resource: "node-main" }],
    target: "role-a",
  });
  const otherRole = await createCardDocument(adapter, {
    cardId: "card-otherrole",
    prompt: "Read node",
    sources: [{ resource: "node-main" }],
    target: "role-b",
  });
  await takeCardDocument(adapter, otherRole.cardId, "role-b");
  const cancelled = await createCardDocument(adapter, {
    cardId: "card-cancelledsource",
    prompt: "Read node",
    sources: [{ resource: "node-main" }],
  });
  const taken = await takeCardDocument(adapter, cancelled.cardId, undefined);
  await deprecateCardDocument(adapter, cancelled.cardId, taken.etag);
  // These publications have changed HEAD, without changing the selected Node.
  assert.deepEqual(await inspectReceivedCardSourceChanges(adapter), { items: [], diagnostics: [] });
  const head = await adapter.history.currentCommit();
  const capture = t.mock.method(adapter.history, "captureUnlocked", async () => {
    throw new Error("query must not capture");
  });
  const write = t.mock.method(adapter, "writeFile", async () => {
    throw new Error("query must not write");
  });
  await fs.writeFile(
    path.join(root, "Main/Main.md"),
    node.replace("exact fact", "new requirement"),
  );
  const filtered = await inspectReceivedCardSourceChanges(adapter, { roleId: "role-a" });
  assert.deepEqual(
    filtered.items.map((item) => item.cardId),
    [received.cardId],
  );
  assert.equal(filtered.items[0]!.nodeId, "node-main");
  assert.equal(filtered.items[0]!.state, "changed");
  assert.equal(filtered.items[0]!.path, "Main/Main.md");
  assert.equal(filtered.diagnostics.length, 0);
  const readBinary = adapter.readBinary.bind(adapter),
    completed: string[] = [];
  let releaseOther!: () => void;
  const otherCanFinish = new Promise<void>((resolve) => {
    releaseOther = resolve;
  });
  const fallback = setTimeout(releaseOther, 200);
  const reads = t.mock.method(adapter, "readBinary", async (file: string) => {
    if (file === otherRole.path) await otherCanFinish;
    const raw = await readBinary(file);
    if (file === received.path) {
      completed.push(received.cardId);
      releaseOther();
    } else if (file === otherRole.path) completed.push(otherRole.cardId);
    return raw;
  });
  const ordered = await inspectReceivedCardSourceChanges(adapter);
  clearTimeout(fallback);
  reads.mock.restore();
  assert.deepEqual(completed, [received.cardId, otherRole.cardId]);
  assert.deepEqual(
    ordered.items.map((item) => item.cardId),
    [otherRole.cardId, received.cardId],
  );
  assert.equal(await adapter.history.currentCommit(), head);
  assert.equal(capture.mock.callCount(), 0);
  assert.equal(write.mock.callCount(), 0);
  capture.mock.restore();
  write.mock.restore();
  await adapter.writeFile("Main/Main.md", node);
  assert.equal((await inspectReceivedCardSourceChanges(adapter)).items.length, 0);
  await adapter.mkdir("Renamed");
  await adapter.move("Main/Main.md", "Renamed/Renamed.md");
  await adapter.removeEmptyDir("Main");
  // A path-only move with identical retained bytes is unchanged.
  assert.equal((await inspectReceivedCardSourceChanges(adapter)).items.length, 0);
  await adapter.writeFile("Renamed/Renamed.md", node.replace("exact fact", "moved and changed"));
  const moved = await inspectReceivedCardSourceChanges(adapter, { roleId: "role-a" });
  assert.equal(moved.items[0]!.path, "Renamed/Renamed.md");
  assert.equal(moved.items[0]!.state, "changed");
  await adapter.remove("Renamed");
  const missing = await inspectReceivedCardSourceChanges(adapter, { roleId: "role-a" });
  assert.equal(missing.items[0]!.state, "missing");
  assert.match(missing.items[0]!.reason, /missing/);
  assert.equal(
    (await listCardDocuments(adapter, { state: "pending" })).items[0]!.cardId,
    pending.cardId,
  );
  t.mock.method(adapter.history, "readVersions", async (versions: readonly DocumentVersion[]) =>
    versions.map(() => new Error("retained history unavailable")),
  );
  const failed = await inspectReceivedCardSourceChanges(adapter, { roleId: "role-a" });
  assert.deepEqual(failed.items, []);
  assert.match(failed.diagnostics[0]!.message, /retained history unavailable/);
  const failedAll = await inspectReceivedCardSourceChanges(adapter);
  assert.deepEqual(
    failedAll.diagnostics.map((item) => item.cardId),
    [otherRole.cardId, received.cardId],
  );
  const failedListed = await inspectReceivedCardSourceChanges(
    adapter,
    {},
    await listCardDocuments(adapter),
  );
  assert.deepEqual(failedListed.diagnostics, failedAll.diagnostics);
});

test("filtered Card lists skip history and keep malformed-header diagnostics", async (t) => {
  const { adapter } = await fixture(t);
  await createCardDocument(adapter, {
    cardId: "card-filtered",
    prompt: "For another role",
    target: "role-b",
  });
  t.mock.method(adapter.history, "available", async () => {
    throw new Error("history must not be queried");
  });
  assert.deepEqual(
    (await listCardDocuments(adapter, { roleId: "role-a", state: "pending" })).items,
    [],
  );
  await adapter.writeFile(
    "cards/card-invalid.md",
    "---\nid: different\ntype: card\nschemaVersion: 3\n---\n",
  );
  assert.deepEqual(
    (await listCardDocuments(adapter, { roleId: "role-a", state: "pending" })).items,
    [
      {
        cardId: "card-invalid",
        path: "cards/card-invalid.md",
        diagnostic: "Card header unavailable; inspect raw",
      },
    ],
  );
});

test("Card list batches matching timestamps and excludes untracked handwritten files", async (t) => {
  const { adapter } = await fixture(t);
  const card = await createCardDocument(adapter, {
    cardId: "card-match",
    prompt: "For A",
    target: "role-a",
  });
  await createCardDocument(adapter, { cardId: "card-excluded", prompt: "For B", target: "role-b" });
  await adapter.writeFile(
    "cards/card-manual.md",
    "---\nid: card-manual\ntype: card\nschemaVersion: 3\nstate: pending\n---\nmanual",
  );
  const expectedTime = await adapter.history.commitTime(card.version.commit);
  const actual = adapter.history.firstCommitTimes.bind(adapter.history);
  const batch = t.mock.method(
    adapter.history,
    "firstCommitTimes",
    async (paths: readonly string[]) => {
      assert.deepEqual([...paths].sort(), ["cards/card-manual.md", card.path].sort());
      return actual(paths);
    },
  );
  const result = (
    await listCardDocuments(adapter, { roleId: "role-a", includeOpen: true, state: "pending" })
  ).items;
  assert.equal(batch.mock.callCount(), 1);
  assert.equal(result.find((item) => item.cardId === card.cardId)!.publishedAt, expectedTime);
  assert.equal(
    result.find((item) => item.cardId === "card-manual"),
    undefined,
  );
  t.mock.method(adapter.history, "available", async () => false);
  const withoutGit = await listCardDocuments(adapter, {
    roleId: "role-a",
    includeOpen: true,
    state: "pending",
  });
  assert.equal(withoutGit.items.length, 0);
});

test("untargeted Card receives without a Role and preserves that choice on retry", async (t) => {
  const { adapter } = await fixture(t);
  const saved = await createCardDocument(adapter, { prompt: "ordinary session input" });
  const taken = (await takeCardDocument(adapter, saved.cardId, undefined)) as Record<
    string,
    unknown
  >;
  assert.equal(taken.state, "consumed");
  assert.equal(taken.receivedBy, undefined);
  assert.equal(parseFrontmatter(await adapter.readFile(saved.path)).data.receivedBy, undefined);
  assert.equal(
    ((await takeCardDocument(adapter, saved.cardId, undefined)) as Record<string, unknown>)
      .replayed,
    true,
  );
  await assert.rejects(
    () => takeCardDocument(adapter, saved.cardId, "role-a"),
    code("RECEPTION_CONFLICT"),
  );
  assert.equal((await listCardDocuments(adapter, { state: "consumed" })).items.length, 1);
  assert.equal(
    (await listCardDocuments(adapter, { roleId: "role-a", state: "consumed", includeOpen: true }))
      .items.length,
    0,
  );
  const targeted = await createCardDocument(adapter, {
    prompt: "targeted input",
    target: "role-a",
  });
  await assert.rejects(
    () => takeCardDocument(adapter, targeted.cardId, undefined),
    /supply --role role-a/,
  );
  await takeCardDocument(adapter, targeted.cardId, "role-a");
  await assert.rejects(
    () => takeCardDocument(adapter, targeted.cardId, undefined),
    code("RECEPTION_CONFLICT"),
  );
});

test("Card publication retains only selected Node/Role sources; moving live Nodes does not rewrite input", async (t) => {
  const { adapter, node } = await fixture(t);
  const reads: string[] = [],
    binary = adapter.readBinary.bind(adapter);
  adapter.readBinary = async (p) => {
    reads.push(p);
    return binary(p);
  };
  const saved = await createCardDocument(adapter, {
    cardId: "card-selected",
    prompt: "Implement this.",
    sources: [
      { resource: "/Main/Main.md", extra: { ordered: [2, 1] } },
      { resource: "/roles/role-a.md" },
      { resource: "https://example.invalid/unread" },
      { resource: "客户访谈结论" },
      { resource: "../external.txt" },
    ],
  });
  assert.deepEqual(reads, ["Main/Main.md", "roles/role-a.md"]);
  const raw = await adapter.readFile(saved.path),
    parsed = parseFrontmatter(raw);
  const sources = parsed.data.sources as Array<{
    resource: string;
    version?: DocumentVersion;
    extra?: unknown;
  }>;
  assert.equal(await adapter.history.read(sources[0]!.version!), node);
  assert.deepEqual(sources[0]!.extra, { ordered: [2, 1] });
  assert.equal(sources[2]!.version, undefined);
  assert.equal((await adapter.history.pathVersions("Other/Other.md")).first, undefined);
  assert.equal(await adapter.exists("snapshots"), false);
  assert.equal(await adapter.exists("card-consumptions"), false);
  assert.equal(
    (await adapter.history.pathVersions(saved.path)).first!.commit,
    saved.version.commit,
  );
  await renameNode(
    { fs: adapter, clock: { now: () => "test" }, tentName: "test" },
    "node-main",
    "Renamed",
  );
  assert.equal(await adapter.readFile(saved.path), raw);
  assert.equal(await adapter.history.read(sources[0]!.version!), node);
  const page = await readCardDocument(adapter, saved.cardId);
  assert.equal(page.text, "Implement this.");
  assert.deepEqual((page as Record<string, unknown>).sources, sources);
});

test("one Card has one receiving Role; retries replay reception and open input stays open", async (t) => {
  const { adapter } = await fixture(t);
  const saved = await createCardDocument(adapter, {
    cardId: "card-target",
    prompt: "work",
    target: "role-a",
  });
  await assert.rejects(
    () => takeCardDocument(adapter, saved.cardId, "role-b"),
    code("RECEPTION_CONFLICT"),
  );
  const first = (await takeCardDocument(adapter, saved.cardId, "role-a")) as Record<
    string,
    unknown
  >;
  assert.equal(first.state, "consumed");
  assert.equal(first.replayed, false);
  const replay = (await takeCardDocument(adapter, saved.cardId, "role-a")) as Record<
    string,
    unknown
  >;
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.version, first.version);
  const open = await createCardDocument(adapter, { cardId: "card-open", prompt: "open" });
  await takeCardDocument(adapter, open.cardId, "role-b");
  const fields = parseFrontmatter(await adapter.readFile(open.path)).data;
  assert.equal(fields.target, undefined);
  assert.equal(fields.receivedBy, "role-b");
  await assert.rejects(
    () => takeCardDocument(adapter, open.cardId, "role-a"),
    code("RECEPTION_CONFLICT"),
  );
  assert.equal(
    (await listCardDocuments(adapter, { roleId: "role-b", state: "consumed" })).items[0]!.cardId,
    open.cardId,
  );
});

test("manual input or management edits stay raw-readable without being retained as reception proof", async (t) => {
  const { adapter } = await fixture(t);
  const path = "cards/card-handwritten.md";
  const published = await createCardDocument(adapter, {
    cardId: "card-handwritten",
    prompt: "original",
    sources: [{ resource: "/Main/Main.md", custom: { keep: true } }],
  });
  const initial = await adapter.readFile(path);
  assert.equal(
    await adapter.history.read((await adapter.history.pathVersions(path)).first!),
    initial,
    "first publication includes the resolved source versions",
  );
  for (const [changed, expected] of [
    [initial.replace("original", "changed prompt"), "INPUT_CHANGED"],
    [initial.replace("keep: true", "keep: false"), "INPUT_CHANGED"],
    [initial.replace("state: pending", "state: consumed\nreceivedBy: role-b"), "STATE_CHANGED"],
    [initial.replace("state: pending", "state: interrupted"), "INVALID_DOCUMENT"],
  ]) {
    await adapter.writeFile(path, changed!);
    const result = (await readCardDocument(adapter, published.cardId, { view: "raw" })) as Record<
      string,
      any
    >;
    assert.equal(result.text, changed);
    assert.equal(result.diagnostic.code, expected);
    assert.equal(
      (await adapter.history.pathVersions(path)).latest!.commit,
      published.version.commit,
    );
    await assert.rejects(
      () => takeCardDocument(adapter, published.cardId, "role-a"),
      code(expected!),
    );
  }
  const malformed = initial.replace("sources:", "sources: [broken");
  await adapter.writeFile(path, malformed);
  assert.equal(
    (await readCardDocument(adapter, published.cardId, { view: "raw" })).text,
    malformed,
  );
  await adapter.remove(path);
  await assert.rejects(
    () => createCardDocument(adapter, { cardId: published.cardId, prompt: "reuse" }),
    /already exists/,
  );
});

test("large Card inputs and source metadata are complete in Core", async (t) => {
  const { adapter } = await fixture(t);
  const prompt = "内容😀\r\n".repeat(4000);
  const card = await createCardDocument(adapter, {
    cardId: "card-large",
    prompt,
    sources: Array.from({ length: 100 }, (_, i) => ({
      resource: `https://example.invalid/${i}`,
      description: "detail".repeat(100),
    })),
  });
  const page = (await readCardDocument(adapter, card.cardId)) as Record<string, any>;
  assert.equal(page.text, prompt);
  assert.equal(page.sources.length, 100);
  assert.equal(page.page, undefined);
  const taken = await takeCardDocument(adapter, card.cardId, "role-a");
  assert.equal(taken.text, prompt);
});

test("Card title remains fixed after publication and list includes first publication time", async (t) => {
  const { adapter } = await fixture(t);
  const card = await createCardDocument(adapter, {
    cardId: "card-title",
    title: "Review findings",
    prompt: "Review this",
  });
  const listed = (await listCardDocuments(adapter)).items.find(
    (item) => item.cardId === card.cardId,
  )!;
  assert.equal(listed.title, "Review findings");
  assert.match(String(listed.publishedAt), /^\d{4}-\d\d-\d\dT/);
  await adapter.writeFile(
    card.path,
    (await adapter.readFile(card.path)).replace("Review findings", "Changed title"),
  );
  await assert.rejects(
    () => takeCardDocument(adapter, card.cardId, undefined),
    code("INPUT_CHANGED"),
  );
});

test("Card publication canonicalizes known Node ids in sources and Markdown links", async (t) => {
  const { adapter } = await fixture(t);
  const card = await createCardDocument(adapter, {
    prompt: "[read](node-main)",
    sources: [{ resource: "node-main" }],
  });
  const published = parseFrontmatter(await adapter.readFile(card.path));
  assert.equal(
    (published.data.sources as Array<{ resource: string }>)[0]!.resource,
    "../Main/Main.md",
  );
  assert.equal(published.body, "[read](../Main/Main.md)");
});

test("pending Cards move with CAS and retain destinations, then freeze at reception", async (t) => {
  const { adapter } = await fixture(t);
  const card = await createCardDocument(adapter, {
    prompt: "Review",
    title: "Fixed title",
    sources: [{ resource: "/Main/Main.md" }],
    target: "role-a",
  });
  const original = parseFrontmatter(await adapter.readFile(card.path));
  const moved = await moveCardDocument(adapter, card.cardId, {
    target: "role-b",
    expectedEtag: card.etag,
  });
  assert.notEqual(moved.etag, card.etag);
  assert.equal(parseFrontmatter(await adapter.history.read(moved.version)).data.target, "role-b");
  assert.equal(parseFrontmatter(await adapter.history.read(card.version)).data.target, "role-a");
  const same = await moveCardDocument(adapter, card.cardId, {
    target: "role-b",
    expectedEtag: moved.etag,
  });
  assert.deepEqual(same.version, moved.version);
  await assert.rejects(
    () => moveCardDocument(adapter, card.cardId, { target: null, expectedEtag: card.etag }),
    code("STATE_CHANGED"),
  );
  await assert.rejects(
    () =>
      moveCardDocument(adapter, card.cardId, { target: "role-missing", expectedEtag: moved.etag }),
    code("ROLE_UNAVAILABLE"),
  );
  await assert.rejects(
    () => takeCardDocument(adapter, card.cardId, "role-a"),
    code("RECEPTION_CONFLICT"),
  );
  const open = await moveCardDocument(adapter, card.cardId, {
    target: null,
    expectedEtag: moved.etag,
  });
  const after = parseFrontmatter(await adapter.readFile(card.path));
  assert.equal(after.data.target, undefined);
  assert.deepEqual(after.data.sources, original.data.sources);
  assert.equal(after.body, original.body);
  assert.equal(after.data.title, original.data.title);
  const taken = (await takeCardDocument(adapter, card.cardId, "role-a")) as Record<string, any>;
  await assert.rejects(
    () => moveCardDocument(adapter, card.cardId, { target: "role-b", expectedEtag: open.etag }),
    (error: any) =>
      error.code === "RECEPTION_CONFLICT" && error.details.current.receivedBy === "role-a",
  );
});

test("manual target edits are management conflicts and moves never adopt changed input", async (t) => {
  const { adapter } = await fixture(t);
  const card = await createCardDocument(adapter, { prompt: "original", target: "role-a" });
  const raw = await adapter.readFile(card.path);
  for (const [changed, expected] of [
    [raw.replace("role-a", "role-b"), "STATE_CHANGED"],
    [raw.replace("original", "changed"), "INPUT_CHANGED"],
  ]) {
    await adapter.writeFile(card.path, changed!);
    await assert.rejects(
      () =>
        moveCardDocument(adapter, card.cardId, {
          target: null,
          expectedEtag: contentEtag(changed!),
        }),
      code(expected!),
    );
    await assert.rejects(() => takeCardDocument(adapter, card.cardId, "role-b"), code(expected!));
    assert.equal(
      (await adapter.history.pathVersions(card.path)).latest!.commit,
      card.version.commit,
    );
  }
});

test("move and take share a lock, and take checks the destination that won", async (t) => {
  const { adapter, root } = await fixture(t);
  const card = await createCardDocument(adapter, { prompt: "Review", target: "role-a" });
  let entered!: () => void, release!: () => void;
  const inside = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = adapter.readFrontmatter.bind(adapter);
  t.mock.method(adapter, "readFrontmatter", async (file: string) => {
    if (file === "roles/role-b.md") {
      entered();
      await gate;
    }
    return read(file);
  });
  const moving = moveCardDocument(adapter, card.cardId, {
    target: "role-b",
    expectedEtag: card.etag,
  });
  await inside;
  try {
    await assert.rejects(
      () => takeCardDocument(new NodeFs(root), card.cardId, "role-a"),
      /already running another write operation/,
    );
  } finally {
    release();
  }
  await moving;
  await assert.rejects(
    () => takeCardDocument(adapter, card.cardId, "role-a"),
    code("RECEPTION_CONFLICT"),
  );
  assert.equal(
    ((await takeCardDocument(adapter, card.cardId, "role-b")) as Record<string, unknown>)
      .receivedBy,
    "role-b",
  );
});
