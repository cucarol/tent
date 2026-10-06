import assert from "node:assert/strict";
import test from "node:test";
import { scaffoldTent } from "../src/core/scaffold.js";
import { createNode } from "../src/core/ops.js";
import { readNodeForEdit } from "../src/core/node-query.js";
import { inspectNodeSync, confirmNodeSync } from "../src/core/node-sync.js";
import { PropagationMemoryFs } from "./propagation-memory.js";
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
    type: "output-evidence",
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
