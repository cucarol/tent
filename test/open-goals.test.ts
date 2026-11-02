import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { PropagationMemoryFs } from "./propagation-memory.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/base/frontmatter.js";
import { isNodeNotePath, nodeNotePath } from "../src/core/base/paths.js";
import type { ContextNode } from "../src/core/read/card-references.js";
import { readGoalOpenStates } from "../src/core/read/open-goals.js";
import { readNodeTimes } from "../src/core/read/node-times.js";
import { readNodeBodyHistory } from "../src/core/read/node-body-history.js";
import { scaffoldTent } from "../src/core/store/scaffold.js";
import type { DocumentVersion } from "../src/core/store/history-port.js";

const workspace = path.resolve(".scratch/open-goals-memory");
async function fixture() {
  const fs = new PropagationMemoryFs();
  await scaffoldTent(fs, { name: "Goals" });
  const node = (folder: string, id: string, type: string, body = "Body", data = {}) =>
    fs.writeFile(nodeNotePath(folder), serializeFrontmatter({ id, type, ...data }, body));
  const save = async () => {
    const retained = await fs.history.retainedPaths();
    return fs.history.captureUnlocked(
      [...new Set([...retained, ...fs.files.keys()])].map((file) => ({
        path: file,
        raw: fs.files.get(file) ?? null,
      })),
      { operation: "test.capture" },
    );
  };
  const nodes = (): ContextNode[] =>
    [...fs.files]
      .filter(([file]) => isNodeNotePath(file))
      .map(([file, raw]) => {
        const { data, body } = parseFrontmatter(raw);
        const folder = path.posix.dirname(file);
        return {
          nodeId: String(data.id),
          name: path.posix.basename(folder),
          path: folder,
          raw,
          body,
          data,
        };
      });
  const read = (ids = ["node-goal"]) => readGoalOpenStates(fs, workspace, nodes(), ids);
  const state = async (id = "node-goal") => (await read([id]))[0]?.state;
  return { fs, node, save, nodes, read, state };
}

test("goal output placement follows event order, including an atomic body edit and placement", async () => {
  const { fs, node, save, state } = await fixture();
  await node("Goal", "node-goal", "goal");
  await save();
  assert.equal(await state(), "open");
  await node("Goal/Out", "node-out", "output");
  await save();
  assert.equal(await state(), "closed");
  const changes = fs.history.changesInRange.bind(fs.history);
  fs.history.changesInRange = async () =>
    (await changes()).map((event) => ({ ...event, time: "2026-01-01T00:00:00.000Z" }));
  await node("Goal", "node-goal", "goal", "Changed goal");
  await save();
  assert.equal(await state(), "open");
  await node("Goal/Out", "node-out", "output", "Changed old output");
  assert.equal(await state(), "open");
  await save();
  assert.equal(await state(), "open");
  await node("Goal", "node-goal", "goal", "Changed goal again");
  await node("Goal/New", "node-new", "output");
  await save();
  assert.equal(await state(), "closed");
});

test("valid structure sources close their own and ancestor goals without history or repository scans", async () => {
  const { fs, node, read } = await fixture();
  await node("Goal", "node-goal", "goal");
  await node("Goal/Old", "node-old", "goal", "Old", { status: "deprecated" });
  await node("Goal/Old/Code", "node-code", "goal", "Code", {
    sources: [{ resource: "../../../../src/", track: "structure" }],
  });
  fs.history.changesInRange = async () => {
    throw new Error("No history");
  };
  assert.deepEqual(await read(["node-goal", "node-code", "node-old"]), [
    { nodeId: "node-goal", state: "closed", basis: "structure" },
    { nodeId: "node-code", state: "closed", basis: "structure" },
  ]);
});

test("plain, deprecated, non-goal, remote, invalid and system structure sources do not close goals", async () => {
  const { node, save, state } = await fixture();
  await node("Goal", "node-goal", "goal", "Goal", {
    sources: [{ resource: "../../src/" }],
  });
  await node("Goal/Old", "node-old", "goal", "Old", {
    status: "deprecated",
    sources: [{ resource: "../../../src/", track: "structure" }],
  });
  await node("Goal/Unknown", "node-unknown", "goal", "Unknown", {
    status: "future",
    sources: [{ resource: "../../../src/", track: "structure" }],
  });
  await node("Goal/Prompt", "node-prompt", "prompt", "Prompt", {
    sources: [{ resource: "../../../src/", track: "structure" }],
  });
  await node("Goal/Remote", "node-remote", "goal", "Remote", {
    sources: [
      { resource: "https://example.test/src/", track: "structure" },
      { resource: "../../../src/file.ts", track: "structure" },
      { resource: "../../../.tent/", track: "structure" },
      { resource: "../../../src/?query", track: "structure" },
      { resource: "../../../src/x*y*", track: "structure" },
    ],
  });
  await save();
  assert.equal(await state(), "open");
});

test("moving or restoring an output places it; editing, renaming or moving its whole goal does not", async () => {
  const { fs, node, save, state } = await fixture();
  await node("Goal", "node-goal", "goal");
  await node("Elsewhere", "node-out", "output");
  await save();
  await node("Goal", "node-goal", "goal", "New requirement");
  await save();
  await fs.move("Elsewhere", "Goal/Out");
  await fs.move("Goal/Out/Elsewhere.md", "Goal/Out/Out.md");
  await save();
  assert.equal(await state(), "closed");
  await node("Goal", "node-goal", "goal", "Later requirement");
  await save();
  assert.equal(await state(), "open");
  await fs.move("Goal/Out", "Goal/Renamed");
  await fs.move("Goal/Renamed/Out.md", "Goal/Renamed/Renamed.md");
  await save();
  assert.equal(await state(), "open");
  await fs.move("Goal", "Moved");
  await fs.move("Moved/Goal.md", "Moved/Moved.md");
  await save();
  assert.equal(await state(), "open");
  await node("Moved/Renamed", "node-out", "output", "Body", { status: "deprecated" });
  await save();
  assert.equal(await state(), "open");
  await node("Moved/Renamed", "node-out", "output");
  await save();
  assert.equal(await state(), "closed");
});

test("missing versions, missing history and uncaptured current bodies produce unknown", async (t) => {
  const { fs, node, save, state, read } = await fixture();
  await node("Goal", "node-goal", "goal");
  assert.equal(await state(), "unknown");
  await save();
  await node("Goal/Out", "node-out", "output");
  assert.equal(await state(), "unknown");
  await save();
  assert.equal(await state(), "closed");
  await node("Goal/Out", "node-out", "output", "Uncaptured output");
  assert.equal(await state(), "closed");
  await node("Goal/Out", "node-out", "output");
  await node("Goal", "node-goal", "goal", "Uncaptured goal");
  assert.equal(await state(), "unknown");
  await node("Goal", "node-goal", "goal");
  const versions = fs.history.readVersions.bind(fs.history);
  t.mock.method(fs.history, "readVersions", async (input: readonly DocumentVersion[]) =>
    (await versions(input)).map((value, i) =>
      input[i]!.path === "Goal/Goal.md" ? new Error("Missing blob") : value,
    ),
  );
  assert.equal(await state(), "unknown");
  assert.deepEqual(await read([]), []);
});

test("uncaptured output moves cannot be substituted for a retained placement", async () => {
  const { fs, node, save, state } = await fixture();
  await node("Goal", "node-goal", "goal");
  await node("Out", "node-out", "output");
  await save();
  await fs.move("Out", "Goal/Out");
  assert.equal(await state(), "unknown");
});

test("unavailable history is unknown while history I/O failures preserve their cause", async () => {
  const { fs, node, save, state } = await fixture();
  await node("Goal", "node-goal", "goal");
  await save();
  fs.history.available = async () => false;
  assert.equal(await state(), "unknown");
  assert.equal((await readNodeTimes(fs, ["node-goal"]))[0]!.contentChangedAt, null);
  fs.history.available = async () => true;
  const failure = Object.assign(new Error("history read failed"), { code: "EIO" });
  const changes = fs.history.changesInRange.bind(fs.history);
  fs.history.changesInRange = async () => {
    throw failure;
  };
  await assert.rejects(state(), (error) => error === failure);
  await assert.rejects(readNodeTimes(fs, ["node-goal"]), (error) => error === failure);
  fs.history.changesInRange = changes;
  fs.history.readVersions = async () => {
    throw failure;
  };
  await assert.rejects(state(), (error) => error === failure);
});

test("only a currently nondeprecated output can keep a goal closed", async () => {
  const { fs, node, save, state } = await fixture();
  await node("Goal", "node-goal", "goal");
  await node("Goal/Out", "node-out", "output");
  await save();
  assert.equal(await state(), "closed");
  await node("Goal/Out", "node-out", "output", "Body", { status: "deprecated" });
  await save();
  assert.equal(await state(), "open");
  await node("Goal/Out", "node-out", "output");
  await save();
  assert.equal(await state(), "closed");
  await fs.remove("Goal/Out");
  await save();
  assert.equal(await state(), "open");
});

test("factual reads preserve current files and retained history", async () => {
  const { fs, node, save, state } = await fixture();
  await node("Goal", "node-goal", "goal");
  await node("Goal/Out", "node-out", "output");
  await save();
  const head = await fs.history.currentCommit();
  const files = new Map(fs.files);
  fs.history.captureUnlocked = async () => {
    throw new Error("Read attempted capture");
  };
  fs.observeMaterial = async () => {
    throw new Error("Read attempted material observation");
  };
  assert.equal(await state(), "closed");
  assert.ok((await readNodeTimes(fs, ["node-goal"]))[0]!.contentChangedAt);
  assert.equal(await fs.history.currentCommit(), head);
  assert.deepEqual(fs.files, files);
});

test("goal body boundaries ignore material and metadata edits and canonicalize move-induced links", async () => {
  const { fs, node, save, state } = await fixture();
  await node("Target", "node-target", "prompt");
  await node("Goal", "node-goal", "goal", "See [target](../Target/Target.md)", {
    resource: "../../a.txt",
  });
  await save();
  const boundary = async () => (await readNodeBodyHistory(fs))?.changed.get("node-goal")?.order;
  const first = await boundary();
  assert.equal(typeof first, "number");
  await node("Goal", "node-goal", "goal", "See [target](../Target/Target.md)", {
    resource: "../../b.txt",
    sources: [{ resource: "../../other.txt" }],
    verified: { opaque: true },
    description: "Metadata",
  });
  await save();
  assert.equal(await boundary(), first);
  await fs.move("Target", "Renamed");
  await fs.move("Renamed/Target.md", "Renamed/Renamed.md");
  await node("Goal", "node-goal", "goal", "See [target](../Renamed/Renamed.md)");
  await save();
  assert.equal(await boundary(), first);
  assert.equal(await state(), "open");
  await node("Goal", "node-goal", "goal", "Changed body");
  assert.equal((await readNodeTimes(fs, ["node-goal"]))[0]!.contentChangedAt, null);
  await save();
  assert.notEqual(await boundary(), first);
});
