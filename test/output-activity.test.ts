import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { readCardProgress, readOutputActivity } from "../src/core/card-progress.js";
import { serializeFrontmatter } from "../src/core/frontmatter.js";
import { NodeFs } from "../src/fs/node-fs.js";

const node = (id: string, type = "output", fields = {}, body = "result") =>
  serializeFrontmatter({ id, type, ...fields }, body);
const time = (day: number) => `2026-01-${String(day).padStart(2, "0")}T02:00:00.000Z`;

async function fixture(t: TestContext) {
  const scratch = path.resolve(".scratch/now-activity");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "history-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const adapter = new NodeFs(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, "-c", "core.autocrlf=false", ...args], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
  let day = 0;
  async function commit(
    changes: Record<string, string | null>,
    operation = "node.write",
    objectIds: string[] = [],
  ) {
    for (const [file, raw] of Object.entries(changes)) {
      if (raw === null) await adapter.remove(file);
      else await adapter.writeFile(file, raw);
    }
    git("add", "--all");
    day++;
    const date = `2026-01-${String(day).padStart(2, "0")}T10:00:00+08:00`;
    execFileSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-qm",
        `Tent: ${operation}\n\nTent-Operation: ${operation}` +
          objectIds.map((id) => `\nTent-Object: ${id}`).join(""),
      ],
      {
        env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
        windowsHide: true,
      },
    );
    return { commit: git("rev-parse", "HEAD"), at: time(day) };
  }
  return { root, adapter, git, commit, query: () => readOutputActivity(adapter) };
}

test("output activity uses retained creation/type/verification events, never ordinary saves or live edits", async (t) => {
  const f = await fixture(t);
  await f.adapter.writeFile("Live/Live.md", node("node-live"));
  assert.deepEqual(
    await f.query(),
    new Map(),
    "a live output without Git has no completion evidence",
  );
  await f.adapter.remove("Live");
  f.git("init", "--quiet");
  await f.commit({ "Prompt/Prompt.md": node("node-prompt", "prompt") });
  assert.deepEqual(await f.query(), new Map());
  const created = await f.commit({
    "Out/Out.md": node("node-out", "output-analysis", {
      generated: { by: "process:test", at: "2025-01-01T00:00:00Z" },
    }),
  });
  assert.deepEqual(await f.query(), new Map([["node-out", created.at]]));
  await f.commit({
    "Out/Out.md": node(
      "node-out",
      "output-analysis",
      {
        generated: { by: "process:test", at: "2030-01-01T00:00:00Z" },
      },
      "ordinary edited body",
    ),
  });
  assert.equal((await f.query()).get("node-out"), created.at);
  const converted = await f.commit({ "Prompt/Prompt.md": node("node-prompt") });
  assert.equal((await f.query()).get("node-prompt"), converted.at);
  const verified = await f.commit({
    "Out/Out.md": node("node-out", "output", {
      verified: { by: "human:cuca", at: "2025-01-01T00:00:00Z" },
    }),
  });
  assert.equal(
    (await f.query()).get("node-out"),
    verified.at,
    "use Git event time, not verified.at",
  );
  await f.adapter.writeFile("Live/Live.md", node("node-live"));
  await f.adapter.writeFile(
    "Out/Out.md",
    node("node-out", "output", {
      verified: { by: "human:cuca", at: "2030-01-01T00:00:00Z" },
    }),
  );
  assert.deepEqual(
    await f.query(),
    new Map([
      ["node-out", verified.at],
      ["node-prompt", converted.at],
    ]),
    "uncaptured changes cannot advance retained activity",
  );
});

test("outputs advance on new goal ownership, but preserved ownership and goal body edits do not", async (t) => {
  const f = await fixture(t);
  f.git("init", "--quiet");
  const created = await f.commit({
    "A/A.md": node("node-a", "prompt"),
    "A/Child/Child.md": node("node-child", "goal"),
    "A/Child/Out/Out.md": node("node-out"),
    "B/B.md": node("node-b", "goal"),
  });
  assert.equal((await f.query()).get("node-out"), created.at);
  const newGoal = await f.commit({ "A/A.md": node("node-a", "goal") });
  assert.equal(
    (await f.query()).get("node-out"),
    newGoal.at,
    "an unchanged output gains a new goal ancestor",
  );
  await f.commit({ "A/A.md": node("node-a", "goal", {}, "ordinary goal edit") });
  assert.equal((await f.query()).get("node-out"), newGoal.at);
  const moved = await f.commit(
    {
      "A/Child/Child.md": null,
      "A/Child/Out/Out.md": null,
      "B/Child/Child.md": node("node-child", "goal"),
      "B/Child/Out/Out.md": node("node-out"),
    },
    "node.move",
  );
  assert.equal((await f.query()).get("node-out"), moved.at);
  await f.commit(
    {
      "B/B.md": null,
      "B/Child/Child.md": null,
      "B/Child/Out/Out.md": null,
      "Renamed/Renamed.md": node("node-b", "goal"),
      "Renamed/Child/Child.md": node("node-child", "goal"),
      "Renamed/Child/Out/Out.md": node("node-out"),
    },
    "node.move",
  );
  assert.equal(
    (await f.query()).get("node-out"),
    moved.at,
    "whole subtree rename preserves goal identities",
  );
  const parent = await f.commit({ "Renamed/Child/Child.md": node("node-newchild", "goal") });
  assert.equal((await f.query()).get("node-out"), parent.at, "a new goal identity adds ownership");
});

test("one Git batch confirms every selected output, including confirmation metadata with unchanged bytes", async (t) => {
  const f = await fixture(t);
  f.git("init", "--quiet");
  const created = await f.commit({
    "A/A.md": node("node-a"),
    "B/B.md": node("node-b"),
    "C/C.md": node("node-c"),
  });
  const verified = { verified: [{ by: "human:cuca", at: "2025-01-01T00:00:00Z" }] };
  const batch = await f.commit(
    {
      "A/A.md": node("node-a", "output", verified),
      "B/B.md": node("node-b", "output", verified),
    },
    "node.sync-confirm",
    ["node-a", "node-b"],
  );
  assert.deepEqual(
    await f.query(),
    new Map([
      ["node-a", batch.at],
      ["node-b", batch.at],
      ["node-c", created.at],
    ]),
  );
  await f.commit({
    "A/A.md": node("node-a", "output", verified, "ordinary save after confirmation"),
  });
  assert.equal((await f.query()).get("node-a"), batch.at);
  const confirmed = await f.commit({}, "node.sync-confirm", ["node-a", "node-b"]);
  const events = await f.adapter.history.changesInRange();
  assert.deepEqual(events.at(-1)!.changes, []);
  assert.deepEqual(
    await readOutputActivity(f.adapter, events),
    new Map([
      ["node-a", confirmed.at],
      ["node-b", confirmed.at],
      ["node-c", created.at],
    ]),
  );
  await f.commit({ "A/A.md": null, "B/B.md": node("node-b", "prompt") }, "node.delete");
  assert.deepEqual(await f.query(), new Map([["node-c", created.at]]));
  const returned = await f.commit({ "A/A.md": node("node-a"), "B/B.md": node("node-b") });
  assert.deepEqual(
    await f.query(),
    new Map([
      ["node-c", created.at],
      ["node-a", returned.at],
      ["node-b", returned.at],
    ]),
  );
});

test("output and Card queries share the derived replay, durable cache, and exact retained HEAD", async (t) => {
  const f = await fixture(t);
  f.git("init", "--quiet");
  const initial = await f.commit({ "Goal/Goal.md": node("node-goal", "goal") });
  const source = {
    resource: "/Goal/Goal.md",
    version: { commit: initial.commit, path: "Goal/Goal.md" },
  };
  await f.commit(
    {
      "cards/card-test.md": serializeFrontmatter(
        { id: "card-test", type: "card", sources: [source] },
        "task",
      ),
    },
    "card.create",
  );
  const created = await f.commit({ "Goal/Out/Out.md": node("node-out") });
  const events = await f.adapter.history.changesInRange();
  const reads = t.mock.method(f.adapter.history, "readVersions");
  const traversal = t.mock.method(f.adapter.history, "changesInRange");
  assert.equal((await readOutputActivity(f.adapter, events)).get("node-out"), created.at);
  const count = reads.mock.callCount();
  assert.ok(count > 0);
  assert.equal(traversal.mock.callCount(), 0, "matching retained events avoid another traversal");
  const card = { cardId: "card-test", state: "consumed" as const, sources: [source] };
  assert.equal(
    (await readCardProgress(f.adapter, [card])).get(card.cardId)!.progress,
    "has-output",
  );
  assert.equal(reads.mock.callCount(), count, "Card progress reuses the output activity replay");
  const fresh = new NodeFs(f.root);
  const freshReads = t.mock.method(fresh.history, "readVersions");
  assert.equal((await readOutputActivity(fresh)).get("node-out"), created.at);
  assert.equal(
    freshReads.mock.callCount(),
    0,
    "a fresh reader reuses the durable exact-HEAD index",
  );
  const cache = JSON.parse(
    await fs.readFile(path.join(f.root, ".git/tent-derived-card-subtree-progress.json"), "utf8"),
  );
  assert.equal(cache.version, 3);
  const converted = await f.commit({ "Goal/Out/Out.md": node("node-out", "prompt") });
  assert.equal(
    (await readOutputActivity(f.adapter, events)).has("node-out"),
    false,
    "stale retained events cannot poison a new HEAD",
  );
  assert.equal(traversal.mock.callCount(), 1);
  f.git("reset", "--quiet", "--hard", created.commit);
  assert.equal((await f.query()).get("node-out"), created.at);
  f.git("reset", "--quiet", "--hard", converted.commit);
  assert.deepEqual(await f.query(), new Map());
});
