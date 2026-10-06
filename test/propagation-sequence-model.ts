import assert from "node:assert/strict";
import path from "node:path";
import { PropagationMemoryFs } from "./propagation-memory.js";
import { scaffoldTent } from "../src/core/scaffold.js";
import { createNode, archiveNode, restoreNode } from "../src/core/ops.js";
import { readNodeForEdit } from "../src/core/node-query.js";
import { writeNodeDocument } from "../src/core/node-document-write.js";
import { appendNodeBody } from "../src/core/node-lightwrite.js";
import { confirmNodeSync, inspectWorkspaceSync, linkNodeOutput } from "../src/core/node-sync.js";
import {
  createCardDocument,
  takeCardDocument,
  readCardDocument,
  listCardDocuments,
  deprecateCardDocument,
} from "../src/core/card-document.js";
import { createRoleContext } from "../src/core/role-context.js";

const outputTypes = ["output-asset", "output-evidence", "output-analysis", "output-issue"] as const;
const roles = ["role-a", "role-b"] as const;
export type Graph = {
  goals: {
    materials: { kind: "file" | "node"; body: string }[];
    outputs: { type: string; card?: number; cardGoal?: number }[];
    cards: { target?: string; receiver?: string; received: boolean }[];
  }[];
};
export type Operation = {
  kind: string;
  goal: number;
  slot?: number;
  output?: number;
  role?: string;
  card?: number;
  explicit?: boolean;
};
export type Sequence = { seed: number; graph: Graph; operations: Operation[] };
export class InvariantFailure extends Error {
  constructor(
    readonly invariant: string,
    message: string,
  ) {
    super(`${invariant}: ${message}`);
  }
}
const normalized = (s: string) => s.replace(/\r\n?/g, "\n");
const implementation = (type: string) => type === "output-asset" || type === "output-evidence";
export function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let x = state;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
export function generate(seed: number): Sequence {
  const rng = random(seed),
    int = (n: number) => Math.floor(rng() * n),
    pick = <T>(xs: readonly T[]) => xs[int(xs.length)]!;
  const depth = seed === 1 ? 2 : seed === 2 || seed === 3 ? 1 : 1 + int(3);
  const graph: Graph = {
    goals: Array.from({ length: depth }, () => ({
      materials: Array.from({ length: int(3) }, () => ({
        kind: pick(["file", "node"] as const),
        body: "material first\nsecond line\n",
      })),
      outputs: Array.from({ length: int(4) }, () => ({ type: pick(outputTypes) })),
      cards: Array.from({ length: int(3) }, () => {
        const target = rng() < 0.5 ? pick(roles) : undefined;
        return { target, receiver: target ?? pick([...roles, undefined]), received: rng() < 0.7 };
      }),
    })),
  };
  for (const goal of graph.goals)
    for (const output of goal.outputs)
      if (goal.cards.length && rng() < 0.6) output.card = int(goal.cards.length);
  const prefix: Operation[] = [];
  // These seeds reproduce the three independently observed failures; remaining steps use the same random operation generator.
  if (seed === 1) {
    graph.goals.forEach((g) => {
      g.outputs = [];
      g.cards = [];
      g.materials = [];
    });
    graph.goals[0]!.materials = [{ kind: "file", body: "material first\n" }];
    graph.goals[0]!.cards = [{ target: "role-b", receiver: "role-b", received: true }];
    graph.goals[1]!.outputs = [{ type: "output-evidence", card: 0, cardGoal: 0 }];
    prefix.push({ kind: "material", goal: 0, slot: 0 }, { kind: "goal-confirm", goal: 0 });
  }
  if (seed === 2) {
    graph.goals[0] = {
      materials: [],
      outputs: [],
      cards: [{ target: "role-b", receiver: "role-b", received: true }],
    };
    prefix.push({ kind: "link", goal: 0, role: "role-a", explicit: false });
  }
  if (seed === 3)
    graph.goals[0] = { materials: [], outputs: [{ type: "output-issue" }], cards: [] };
  if (seed === 4) {
    graph.goals = Array.from({ length: 3 }, () => ({
      materials: [
        { kind: "file", body: "file input\n" },
        { kind: "node", body: "Node input\n" },
      ],
      outputs: [{ type: "output-evidence" }, { type: "output-issue" }],
      cards: [{ target: "role-b", receiver: "role-b", received: true }],
    }));
    prefix.push(
      { kind: "material-lines", goal: 0, slot: 0 },
      { kind: "material-confirm", goal: 0, slot: 1 },
      { kind: "goal-tags", goal: 1 },
      { kind: "goal-type", goal: 1 },
      { kind: "material", goal: 0, slot: 0 },
      { kind: "output-confirm", goal: 2, output: 0 },
      { kind: "goal-confirm", goal: 0 },
      { kind: "goal-append", goal: 1 },
      { kind: "output-rewrite", goal: 2, output: 0 },
      { kind: "goal-body", goal: 2 },
      { kind: "link", goal: 2, explicit: true, role: "role-a", card: 0 },
      { kind: "output-material", goal: 2, output: 2 },
      { kind: "output-confirm", goal: 2, output: 2 },
      { kind: "archive-output", goal: 2, output: 2 },
      { kind: "restore-output", goal: 2, output: 2 },
      { kind: "card-deprecate", goal: 2, card: 0 },
      { kind: "archive-goal", goal: 0 },
      { kind: "restore-goal", goal: 0 },
    );
  }
  const kinds = [
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
  ];
  const operations = [...prefix];
  const length = 20 + int(31);
  while (operations.length < length)
    operations.push({
      kind: pick(kinds),
      goal: int(graph.goals.length),
      slot: int(2),
      output: int(3),
      role: pick([...roles, undefined]),
      card: int(2),
      explicit: rng() < 0.5,
    });
  return { seed, graph, operations };
}

type Material = { kind: "file" | "node"; location: string; id?: string; body: string };
type Goal = { id: string; path: string; body: string; materials: Material[]; active: boolean };
type Output = {
  id: string;
  goal: number;
  path: string;
  type: string;
  active: boolean;
  card?: string;
  resource?: Material;
  baseline: string[];
  ownBasis?: string;
};
type Card = { id: string; goal: number; received: boolean; receiver?: string; active: boolean };

/** Oracle stores readable semantic values. It never reads Core fingerprints or retained records. */
export class SequenceRunner {
  readonly fs = new PropagationMemoryFs();
  readonly env = {
    fs: this.fs,
    clock: { now: () => "2026-10-06T00:00:00.000Z" },
    tentName: "Propagation",
    rand: random(1789),
  };
  readonly goals: Goal[] = [];
  readonly outputs: Output[] = [];
  readonly cards: Card[] = [];
  readonly archives = new Map<string, { commit: string; statuses: Map<string, boolean> }>();
  private tick = 0;
  readonly executed = new Set<string>();

  private goalValue(goal: Goal) {
    return JSON.stringify([normalized(goal.body), goal.materials.map((m) => [m.kind, m.location])]);
  }
  private basis(index: number) {
    return this.goals
      .slice(0, index + 1)
      .flatMap((g) => [this.goalValue(g), ...g.materials.map((m) => normalized(m.body))]);
  }
  private goalDrift(output: Output) {
    return JSON.stringify(output.baseline) !== JSON.stringify(this.basis(output.goal));
  }
  private driftForGoal(output: Output, index: number) {
    const offset = this.goals
      .slice(0, index)
      .reduce((total, g) => total + 1 + g.materials.length, 0);
    const size = 1 + this.goals[index]!.materials.length;
    return (
      JSON.stringify(output.baseline.slice(offset, offset + size)) !==
      JSON.stringify(this.basis(output.goal).slice(offset, offset + size))
    );
  }
  private behind(output: Output) {
    return (
      this.goalDrift(output) ||
      !!(output.resource && output.ownBasis !== normalized(output.resource.body))
    );
  }
  private reset(output: Output) {
    output.baseline = this.basis(output.goal);
    output.ownBasis = output.resource ? normalized(output.resource.body) : undefined;
  }
  private fail(invariant: string, message: string) {
    throw new InvariantFailure(invariant, message);
  }
  private expect(condition: unknown, invariant: string, message: string) {
    if (!condition) this.fail(invariant, message);
  }
  private async edit(id: string, patch: Parameters<typeof writeNodeDocument>[2]) {
    const read = await readNodeForEdit(this.fs, id);
    return writeNodeDocument(this.fs, id, { baseEtag: read.etag, ...patch });
  }
  private async confirm(id: string) {
    const read = await readNodeForEdit(this.fs, id);
    return confirmNodeSync(this.fs, id, { baseEtag: read.etag });
  }
  private relative(from: string, to: string) {
    const rel = path.posix.relative(from, to);
    return rel.startsWith(".") ? rel : "./" + rel;
  }

  async setup(graph: Graph) {
    await scaffoldTent(this.fs, { name: "Propagation" });
    for (const roleId of roles)
      await createRoleContext(this.fs, { roleId, title: roleId, body: "work direction" });
    for (const [index, spec] of graph.goals.entries()) {
      const parentPath = this.goals.at(-1)?.path ?? "",
        goalPath = parentPath ? `${parentPath}/G${index}` : `G${index}`;
      const materials: Material[] = [];
      for (const [slot, material] of spec.materials.entries()) {
        let location: string, id: string | undefined;
        if (material.kind === "file") {
          location = `../material-${index}-${slot}.txt`;
          await this.fs.writeFile(location, material.body);
        } else {
          const name = `M${index}_${slot}`;
          id = await createNode(this.env, {
            parentPath: "",
            name,
            type: "prompt-reference",
            body: material.body,
          });
          location = `${name}/${name}.md`;
        }
        materials.push({ kind: material.kind, location, id, body: material.body });
      }
      const body = `goal ${index}\n`;
      const id = await createNode(this.env, {
        parentPath,
        name: `G${index}`,
        type: "goal-requirement",
        body,
        sources: materials.map((m) => ({ resource: this.relative(goalPath, m.location) })),
      });
      this.goals.push({ id, path: goalPath, body, materials, active: true });
    }
    for (const [goal, spec] of graph.goals.entries()) {
      for (const [slot, c] of spec.cards.entries()) {
        const id = `card-g${goal}s${slot}`;
        await createCardDocument(this.fs, {
          cardId: id,
          prompt: "implement",
          target: c.target,
          sources: [{ resource: `/${this.goals[goal]!.path}/G${goal}.md` }],
        });
        if (c.received) await takeCardDocument(this.fs, id, c.receiver);
        this.cards.push({ id, goal, received: c.received, receiver: c.receiver, active: true });
      }
      for (const [slot, o] of spec.outputs.entries()) {
        const parentPath = this.goals[goal]!.path,
          name = `O${slot}`;
        const card =
          o.card === undefined
            ? undefined
            : this.cards.filter((c) => c.goal === (o.cardGoal ?? goal))[o.card]?.id;
        const id = await createNode(this.env, {
          parentPath,
          name,
          type: o.type,
          body: "observed output\n",
          ...(card ? { sources: [{ resource: `/cards/${card}.md` }] } : {}),
        });
        this.outputs.push({
          id,
          goal,
          path: `${parentPath}/${name}`,
          type: o.type,
          active: true,
          card,
          baseline: this.basis(goal),
        });
      }
    }
  }

  async check() {
    const actual = await inspectWorkspaceSync(this.fs);
    const byId = new Map(actual.nodes.map((n) => [n.nodeId, n]));
    for (const output of this.outputs.filter((o) => o.active)) {
      const inspected = byId.get(output.id);
      this.expect(inspected, "I1", `active output ${output.path} missing`);
      const currentBasis = this.basis(output.goal);
      const materialChanged = this.goals.slice(0, output.goal + 1).some((g, i) => {
        const offset = this.goals
          .slice(0, i)
          .reduce((total, parent) => total + 1 + parent.materials.length, 0);
        return g.materials.some(
          (_m, slot) => output.baseline[offset + slot + 1] !== currentBasis[offset + slot + 1],
        );
      });
      const invariant = !this.behind(output)
        ? "I5"
        : materialChanged
          ? "I1-material"
          : this.goalDrift(output)
            ? "I1-goal"
            : "I1-own-material";
      this.expect(
        !!inspected!.behind === this.behind(output),
        invariant,
        `${output.path} behind expected=${this.behind(output)} actual=${!!inspected!.behind}`,
      );
      for (const material of inspected!.materials.filter((m) => m.state === "changed")) {
        this.expect(
          material.recordedVersion &&
            material.currentVersion &&
            material.recordedVersion !== material.currentVersion,
          "I6",
          `${output.path}: changed record must contain distinct versions: ${JSON.stringify(material)}`,
        );
        this.expect(
          material.resource,
          "I6",
          `${output.path}: changed record lacks material address`,
        );
        this.expect(
          inspected!.behind?.reasons.some((reason) => reason.includes(material.resource)),
          "I6",
          `${output.path}: behind reason must identify concrete material ${material.resource}`,
        );
        // All inherited rows must name their actual goal and concrete material, either in the address or in a reason.
        const extended = material as typeof material & { goalId?: string };
        const text = `${material.resource} ${material.reason ?? ""} ${extended.goalId ?? ""}`;
        if (
          !output.resource ||
          material.resource !== this.relative(output.path, output.resource.location)
        ) {
          const changedGoals = this.goals
            .slice(0, output.goal + 1)
            .filter((g) => text.includes(g.id) || text.includes(g.path));
          this.expect(
            changedGoals.length > 0,
            "I6",
            `${output.path}: inherited finding does not identify its goal: ${text}`,
          );
          this.expect(
            extended.goalId &&
              this.goals.slice(0, output.goal + 1).some((goal) => goal.id === extended.goalId),
            "I6",
            `${output.path}: inherited changed material must expose its exact goalId`,
          );
          this.expect(
            inspected!.behind?.reasons.some(
              (reason) => reason.includes(material.resource) && reason.includes(extended.goalId!),
            ),
            "I6",
            `${output.path}: behind reason must identify inherited goal ${extended.goalId}`,
          );
        }
      }
    }
    for (const [index, goal] of this.goals.entries())
      if (goal.active) {
        const subtree = this.outputs.filter(
          (o) => o.active && o.goal >= index && implementation(o.type),
        );
        const expectedAhead = !subtree.length || subtree.some((o) => this.driftForGoal(o, index));
        this.expect(
          !!byId.get(goal.id)?.ahead === expectedAhead,
          "I3",
          `${goal.path} ahead expected=${expectedAhead} actual=${!!byId.get(goal.id)?.ahead}`,
        );
      }
    const listed = await listCardDocuments(this.fs);
    const cards = new Map(listed.items.map((c) => [String(c.cardId), c]));
    for (const card of this.cards.filter((c) => c.active)) {
      const actualCard = cards.get(card.id);
      this.expect(
        actualCard && !actualCard.diagnostic,
        "I2/I4",
        `Card unavailable ${card.id}: ${JSON.stringify(actualCard)}`,
      );
      const responding = this.outputs.filter(
        (o) =>
          o.active &&
          implementation(o.type) &&
          o.card === card.id &&
          o.goal >= card.goal &&
          this.goals[card.goal]!.active,
      );
      const complete = responding.filter((o) => !this.behind(o));
      const review = responding.filter((o) => this.behind(o));
      const expected = !card.received
        ? "pending"
        : complete.length
          ? "has-output"
          : review.length
            ? "needs-review"
            : "received-no-output";
      this.expect(
        actualCard!.progress === expected,
        "I2/I4",
        `${card.id} progress expected=${expected} actual=${actualCard!.progress}`,
      );
      const ids = actualCard!.outputNodeIds as string[];
      this.expect(
        JSON.stringify([...ids].sort()) === JSON.stringify(complete.map((o) => o.id).sort()),
        "I2",
        `${card.id} completed outputs must be only current asset/evidence`,
      );
      // Role's "last completed" selector consumes these has-output Cards; every eligible Card must have a current result.
      if (card.receiver && actualCard!.progress === "has-output")
        this.expect(
          complete.length,
          "I2",
          `${card.receiver} must not select ${card.id} as completed with only behind results`,
        );
    }
  }

  async apply(op: Operation) {
    this.tick++;
    const goal = this.goals[op.goal];
    if (!goal) return;
    const output = this.outputs.filter((o) => o.goal === op.goal)[op.output ?? 0];
    const material = goal.materials[op.slot ?? 0];
    if (op.kind === "restore-goal" || op.kind === "restore-output") {
      const selected = op.kind === "restore-goal" ? goal : output;
      if (!selected) return;
      const archive = this.archives.get(selected.id);
      if (!archive) return;
      // Only restore an unchanged archived subtree; interleaved writes make the real Core operation intentionally invalid.
      const changes = await this.fs.history.commitChanges(archive.commit);
      if (
        (
          await Promise.all(
            changes.changes.map((c) =>
              this.fs.history.changedSince({ commit: archive.commit, path: c.path }),
            ),
          )
        ).some(Boolean)
      )
        return;
      await restoreNode(this.env, selected.id, archive.commit);
      this.executed.add(op.kind);
      for (const g of this.goals)
        if (archive.statuses.has(g.id)) g.active = archive.statuses.get(g.id)!;
      for (const o of this.outputs)
        if (archive.statuses.has(o.id)) o.active = archive.statuses.get(o.id)!;
      this.archives.delete(selected.id);
      return;
    }
    if (!goal.active && op.kind !== "card-deprecate") return;
    if (op.kind === "material" || op.kind === "material-lines") {
      if (!material) return;
      material.body =
        op.kind === "material"
          ? `material revision ${this.tick}\nsecond line\n`
          : normalized(material.body).replace(/\n/g, "\r\n");
      if (material.id) await this.edit(material.id, { body: material.body });
      else await this.fs.writeFile(material.location, material.body);
    } else if (op.kind === "material-confirm") {
      if (!material?.id) return;
      await this.confirm(material.id);
    } else if (op.kind === "goal-body") {
      goal.body = `goal revision ${this.tick}\n`;
      await this.edit(goal.id, { body: goal.body });
    } else if (op.kind === "goal-tags")
      await this.edit(goal.id, { frontmatter: { tags: [`tag-${this.tick}`] } });
    else if (op.kind === "goal-type")
      await this.edit(goal.id, {
        frontmatter: { type: this.tick % 2 ? "goal-direction" : "goal-requirement" },
      });
    else if (op.kind === "goal-append") {
      await appendNodeBody(this.fs, goal.id, { body: `addition ${this.tick}` });
      // The append contract normalizes boundary whitespace; mirror text formatting, never sync state or hashes.
      goal.body = normalized(goal.body).replace(/\s+$/, "") + `\n\naddition ${this.tick}\n`;
    } else if (op.kind === "goal-confirm") await this.confirm(goal.id);
    else if (op.kind === "output-confirm" || op.kind === "output-rewrite") {
      if (!output?.active) return;
      if (op.kind === "output-confirm") await this.confirm(output.id);
      else await this.edit(output.id, { body: `rewritten output ${this.tick}\n` });
      this.reset(output);
    } else if (op.kind === "output-material") {
      if (!output?.active || !output.resource) return;
      output.resource.body = `changed output bytes ${this.tick}\n`;
      await this.fs.writeFile(output.resource.location, output.resource.body);
    } else if (op.kind === "archive-goal" || op.kind === "archive-output") {
      const selected = op.kind === "archive-goal" ? goal : output;
      if (!selected?.active) return;
      const statuses = new Map<string, boolean>();
      for (const g of this.goals)
        if (g.path === selected.path || g.path.startsWith(selected.path + "/"))
          statuses.set(g.id, g.active);
      for (const o of this.outputs)
        if (o.path === selected.path || o.path.startsWith(selected.path + "/"))
          statuses.set(o.id, o.active);
      const result = await archiveNode(this.env, selected.id);
      if (result.changed && result.commit) {
        this.archives.set(selected.id, { commit: result.commit, statuses });
        for (const g of this.goals) if (statuses.has(g.id)) g.active = false;
        for (const o of this.outputs) if (statuses.has(o.id)) o.active = false;
      }
    } else if (op.kind === "card-deprecate") {
      const card = this.cards.filter((c) => c.goal === op.goal)[op.card ?? 0];
      if (!card?.active) return;
      const read = await readCardDocument(this.fs, card.id);
      await deprecateCardDocument(this.fs, card.id, String(read.etag));
      card.active = false;
    } else if (op.kind === "link") await this.link(op);
    if (op.kind !== "link") this.executed.add(op.kind);
  }

  private async link(op: Operation) {
    const goal = this.goals[op.goal]!;
    const explicit = op.explicit
      ? this.cards.filter((c) => c.goal === op.goal)[op.card ?? 0]
      : undefined;
    if (op.explicit && !explicit?.active) return;
    const relevant = this.cards.filter(
      (c) =>
        c.active &&
        c.received &&
        c.goal === op.goal &&
        !this.outputs.some(
          (o) => o.active && o.card === c.id && implementation(o.type) && !this.behind(o),
        ),
    );
    const eligible = relevant.filter((c) => op.role && c.receiver === op.role);
    const reject = !explicit && relevant.length > 0 && eligible.length !== 1;
    const resource: Material = {
      kind: "file",
      location: `../result-${this.tick}.txt`,
      body: "output file\n",
    };
    await this.fs.writeFile(resource.location, resource.body);
    const input = {
      resource: `result-${this.tick}.txt`,
      name: `Linked${this.tick}`,
      roleId: op.role,
      ...(explicit ? { cardId: explicit.id } : {}),
    };
    if (reject) {
      let error: unknown;
      try {
        await linkNodeOutput(this.fs, goal.id, input);
      } catch (caught) {
        error = caught;
      }
      this.expect(
        error instanceof Error && /--card/.test(error.message),
        "I4-attribution",
        `automatic link role=${op.role ?? "missing"} must require --card for ${relevant.map((c) => `${c.id}:${c.receiver ?? "missing"}`).join(",")}`,
      );
      this.executed.add(op.kind);
      return;
    }
    const receipt = await linkNodeOutput(this.fs, goal.id, input);
    const chosen = explicit ?? eligible[0];
    this.expect(
      (receipt as typeof receipt & { cardId?: string }).cardId === chosen?.id,
      "I4-receipt",
      `link receipt must identify selected card=${chosen?.id ?? "none"}`,
    );
    this.outputs.push({
      id: receipt.nodeId,
      goal: op.goal,
      path: receipt.path,
      type: "output-asset",
      active: true,
      card: chosen?.id,
      resource,
      baseline: this.basis(op.goal),
      ownBasis: normalized(resource.body),
    });
    this.executed.add(op.kind);
  }
}

export async function replay(
  sequence: Sequence,
  operations = sequence.operations,
  coverage?: (executed: Set<string>) => void,
): Promise<InvariantFailure | undefined> {
  const runner = new SequenceRunner();
  await runner.setup(sequence.graph);
  try {
    await runner.check();
    for (const op of operations) {
      await runner.apply(op);
      await runner.check();
    }
  } catch (error) {
    if (error instanceof InvariantFailure) return error;
    throw error;
  }
  coverage?.(runner.executed);
}

/** Delta debugging removes chunks, then individual operations, replaying from fresh storage each time. */
export async function shrink(sequence: Sequence, failure: InvariantFailure) {
  let minimal = [...sequence.operations],
    granularity = 2;
  const same = async (candidate: Operation[]) => {
    try {
      return (await replay(sequence, candidate))?.invariant === failure.invariant;
    } catch {
      return false;
    } // Removed prerequisites can invalidate a candidate; that is not the original failure.
  };
  if (await same([])) return [];
  while (minimal.length > 1) {
    const size = Math.ceil(minimal.length / granularity);
    let reduced = false;
    for (let start = 0; start < minimal.length; start += size) {
      const candidate = [...minimal.slice(0, start), ...minimal.slice(start + size)];
      if (await same(candidate)) {
        minimal = candidate;
        granularity = Math.max(2, granularity - 1);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (granularity >= minimal.length) break;
      granularity = Math.min(minimal.length, granularity * 2);
    }
  }
  for (let i = 0; i < minimal.length;) {
    const candidate = minimal.filter((_op, index) => index !== i);
    if (await same(candidate)) minimal = candidate;
    else i++;
  }
  assert.equal((await replay(sequence, minimal))?.invariant, failure.invariant);
  return minimal;
}
