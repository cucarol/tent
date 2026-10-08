import assert from "node:assert/strict";
import test from "node:test";
import { scaffoldTent } from "../src/core/scaffold.js";
import { createNode } from "../src/core/ops.js";
import { readNodeForEdit } from "../src/core/node-query.js";
import { inspectNodeSync, confirmNodeSync } from "../src/core/node-sync.js";
import { PropagationMemoryFs } from "./propagation-memory.js";
import { writeNodeDocument } from "../src/core/node-document-write.js";
import {
  createCardDocument,
  takeCardDocument,
  listCardDocuments,
} from "../src/core/card-document.js";
import { generate, replay, shrink, type Sequence } from "./propagation-sequence-model.js";

test("propagation baseline: ancestor material change survives goal confirmation", async () => {
  const fs = new PropagationMemoryFs();
  await scaffoldTent(fs, { name: "Propagation" });
  const env = { fs, clock: { now: () => "2026-10-06T00:00:00.000Z" }, tentName: "Propagation" };
  await fs.writeFile("../material.txt", "first\n");
  const outer = await createNode(env, {
    name: "Outer",
    type: "goal",
    parentPath: "",
    body: "direction",
    resource: "../../material.txt",
  });
  await createNode(env, { name: "Inner", type: "goal", parentPath: "Outer", body: "requirement" });
  const output = await createNode(env, {
    name: "Result",
    type: "output",
    parentPath: "Outer/Inner",
    body: "observed",
  });
  await fs.writeFile("../material.txt", "second\n");
  const current = await readNodeForEdit(fs, outer);
  await confirmNodeSync(fs, outer, { baseEtag: current.etag });
  assert.ok(
    (await inspectNodeSync(fs, output)).behind,
    "seed=ancestor-confirm; trace=[material-change outer, confirm outer]; I1 nested output must remain behind",
  );
});

test("deprecated ancestor stays in output dependencies while Card excludes its direct request", async () => {
  const fs = new PropagationMemoryFs();
  await scaffoldTent(fs, { name: "Propagation" });
  const env = { fs, clock: { now: () => "2026-10-06T00:00:00.000Z" }, tentName: "Propagation" };
  await fs.writeFile("../material.txt", "first\n");
  const outer = await createNode(env, {
    parentPath: "",
    name: "Outer",
    type: "goal",
    resource: "../../material.txt",
  });
  const inner = await createNode(env, { parentPath: "Outer", name: "Inner", type: "goal" });
  await createCardDocument(fs, {
    cardId: "card-request",
    prompt: "implement",
    sources: [{ resource: "/Outer/Outer.md" }, { resource: "/Outer/Inner/Inner.md" }],
  });
  await takeCardDocument(fs, "card-request");
  const output = await createNode(env, {
    parentPath: "Outer/Inner",
    name: "Evidence",
    type: "output",
    tags: ["evidence"],
    sources: [{ resource: "/cards/card-request.md" }],
  });
  await fs.writeFile("../material.txt", "second\n");
  const current = await readNodeForEdit(fs, outer);
  await writeNodeDocument(fs, outer, {
    baseEtag: current.etag,
    frontmatter: { status: "deprecated" },
  });
  const inspected = await inspectNodeSync(fs, output);
  assert.deepEqual(inspected.goalIds, [inner, outer]);
  assert.ok(inspected.behind);
  const card = (await listCardDocuments(fs)).items.find((c) => c.cardId === "card-request")!;
  assert.equal(card.totalGoalCount, 1);
  assert.equal(card.progress, "needs-review");
  assert.deepEqual(card.outputNodeIds, []);
  assert.deepEqual(card.reviewOutputNodeIds, [output]);
});

test("propagation oracle rejects explicit unreceived Cards", async () => {
  assert.equal(
    await replay({
      seed: 0,
      graph: { goals: [{ materials: [], outputs: [], cards: [{ received: false }] }] },
      operations: [{ kind: "link", goal: 0, explicit: true, card: 0 }],
    }),
    undefined,
  );
});

const seeds = process.env.TENT_PROPAGATION_SEED
  ? process.env.TENT_PROPAGATION_SEED.split(",").map(Number)
  : [1, 2, 3, 4, 41, 918, 20261006];
for (const seed of seeds) {
  test(`propagation random sequence seed=${seed}`, { timeout: 30_000 }, async () => {
    assert.ok(
      Number.isInteger(seed) && seed >= 0,
      "TENT_PROPAGATION_SEED must contain nonnegative integer seeds",
    );
    const sequence: Sequence = process.env.TENT_PROPAGATION_REPLAY
      ? { ...generate(seed), ...JSON.parse(process.env.TENT_PROPAGATION_REPLAY) }
      : generate(seed);
    let executed = new Set<string>();
    const failure = await replay(sequence, sequence.operations, (coverage) => {
      executed = coverage;
    });
    if (failure) {
      const minimal = await shrink(sequence, failure);
      assert.fail(
        `${failure.message}\nseed=${seed}\nminimal replay=${JSON.stringify({ graph: sequence.graph, operations: minimal })}\noriginal operations=${JSON.stringify(sequence.operations)}`,
      );
    }
    if (seed === 4 && !process.env.TENT_PROPAGATION_REPLAY) {
      assert.deepEqual(
        [...executed].sort(),
        [
          "material",
          "material-lines",
          "material-confirm",
          "goal-body",
          "goal-tags",
          "goal-type",
          "goal-append",
          "goal-confirm",
          "output-confirm",
          "output-rewrite",
          "output-material",
          "link",
          "archive-goal",
          "restore-goal",
          "archive-output",
          "restore-output",
          "card-deprecate",
        ].sort(),
        "seed 4 must execute every operation through the real Core",
      );
    }
  });
}
