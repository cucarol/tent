import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { scaffoldTent } from "../src/core/scaffold.js";
import { createNode } from "../src/core/ops.js";
import { createRoleContext } from "../src/core/role-context.js";
import {
  createCardDocument,
  deprecateCardDocument,
  readCardDocument,
  takeCardDocument,
} from "../src/core/card-document.js";
import { linkNodeOutput } from "../src/core/node-sync.js";
import { parseFrontmatter } from "../src/core/frontmatter.js";
import { nodeNotePath } from "../src/core/paths.js";
import { PropagationMemoryFs } from "./propagation-memory.js";

async function fixture() {
  const fs = new PropagationMemoryFs();
  await scaffoldTent(fs, { name: "Card response boundary" });
  const env = {
    fs,
    clock: { now: () => "2026-10-06T00:00:00.000Z" },
    tentName: "Card response boundary",
  };
  const outerId = await createNode(env, {
    name: "Outer",
    type: "goal",
    parentPath: "",
    body: "Direction",
  });
  const innerId = await createNode(env, {
    name: "Inner",
    type: "goal",
    parentPath: "Outer",
    body: "Requirement",
  });
  await createNode(env, {
    name: "Other",
    type: "goal",
    parentPath: "",
    body: "Unrelated requirement",
  });
  await createNode(env, {
    name: "Notes",
    type: "prompt-spec",
    parentPath: "",
    body: "Agreements",
  });
  await createRoleContext(fs, { roleId: "role-a", title: "A", body: "Direction A" });
  await createRoleContext(fs, { roleId: "role-b", title: "B", body: "Direction B" });
  const card = (id: string, source: string) =>
    createCardDocument(fs, {
      cardId: id,
      prompt: "Implement the selected goal",
      target: "role-a",
      sources: [{ resource: `/${source}` }],
    });
  return { fs, card, outerId, innerId };
}

async function assertRejectedWithoutWrites(
  t: TestContext,
  fs: PropagationMemoryFs,
  goalId: string,
  cardId: string,
  message: RegExp,
) {
  const before = {
    files: [...fs.files],
    directories: [...fs.directories],
    head: await fs.history.currentCommit(),
    records: await fs.history.nodeRecords(),
  };
  const writes = [
    t.mock.method(fs, "writeFile"),
    t.mock.method(fs, "writeBinary"),
    t.mock.method(fs, "mkdir"),
    t.mock.method(fs, "move"),
    t.mock.method(fs, "remove"),
    t.mock.method(fs, "removeEmptyDir"),
    t.mock.method(fs.history, "captureUnlocked"),
  ];
  await assert.rejects(
    linkNodeOutput(fs, goalId, {
      cardId,
      roleId: "role-b",
      resource: "https://example.org/result",
      name: "Result",
    }),
    (error: unknown) =>
      (error as { code?: string }).code === "INVALID_INPUT" &&
      message.test((error as Error).message),
  );
  assert.deepEqual(
    {
      files: [...fs.files],
      directories: [...fs.directories],
      head: await fs.history.currentCommit(),
      records: await fs.history.nodeRecords(),
    },
    before,
  );
  for (const write of writes) {
    assert.equal(write.mock.callCount(), 0);
    write.mock.restore();
  }
}

test("explicit output responses reject pending and deprecated Cards without writes", async (t) => {
  const { fs, card, innerId } = await fixture();
  const pending = await card("card-pendingoutput", "Outer/Inner/Inner.md");
  await assertRejectedWithoutWrites(t, fs, innerId, pending.cardId, /current received Card/);
  const cancelled = await card("card-cancelledoutput", "Outer/Inner/Inner.md");
  const taken = await takeCardDocument(fs, cancelled.cardId, "role-a");
  await deprecateCardDocument(fs, cancelled.cardId, taken.etag);
  await assertRejectedWithoutWrites(t, fs, innerId, cancelled.cardId, /current received Card/);
});

test("explicit output responses require a pinned goal in the current output goal chain", async (t) => {
  const { fs, card, outerId, innerId } = await fixture();
  for (const [id, source, goal] of [
    ["card-unrelatedoutput", "Other/Other.md", innerId],
    ["card-nogoaloutput", "Notes/Notes.md", innerId],
    ["card-descendantoutput", "Outer/Inner/Inner.md", outerId],
  ] as const) {
    const selected = await card(id, source);
    await takeCardDocument(fs, selected.cardId, "role-a");
    await assertRejectedWithoutWrites(t, fs, goal, selected.cardId, /source goal.*goal chain/);
  }
});

test("explicit responses accept selected and ancestor goals across Role boundaries", async () => {
  const { fs, card, innerId } = await fixture();
  for (const [id, source, name] of [
    ["card-directoutput", "Outer/Inner/Inner.md", "Direct result"],
    ["card-ancestoroutput", "Outer/Outer.md", "Ancestor result"],
  ] as const) {
    const selected = await card(id, source);
    await takeCardDocument(fs, selected.cardId, "role-a");
    const receipt = await linkNodeOutput(fs, innerId, {
      cardId: selected.cardId,
      roleId: "role-b",
      resource: "https://example.org/result",
      name,
    });
    assert.equal(receipt.cardId, selected.cardId);
    assert.deepEqual(parseFrontmatter(await fs.readFile(nodeNotePath(receipt.path))).data.sources, [
      { resource: `/cards/${selected.cardId}.md` },
    ]);
    const read = (await readCardDocument(fs, selected.cardId)) as Record<string, unknown>;
    assert.equal(read.receivedBy, "role-a");
    assert.equal(read.progress, "has-output");
    assert.deepEqual(read.outputNodeIds, [receipt.nodeId]);
  }
});

test("a missing explicit Card is rejected before any write without exposing a filesystem path", async (t) => {
  const { fs, innerId } = await fixture();
  await assertRejectedWithoutWrites(
    t,
    fs,
    innerId,
    "card-missingoutput",
    /^Card card-missingoutput does not exist\.$/,
  );
});
