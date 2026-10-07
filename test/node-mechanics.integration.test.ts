import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { NodeFs } from "../src/fs/node-fs.js";

const preload = path.resolve("test/fixtures/git-process-preload.cjs");
const cli = path.resolve("src/cli/tent.ts");
const body = "## Alpha\n\nA confirmed fact.\n\n## Beta\n\nAnother fact.\n";
type Trace = { event: string; id: number; code?: number; args?: string[]; indexFile?: string };

test("Node Git budgets use retained history and unchanged selected bytes, with fresh CLI processes", async (t) => {
  await fs.mkdir(".scratch/node-mechanics", { recursive: true });
  const scratch = await fs.mkdtemp(path.resolve(".scratch/node-mechanics/budgets-"));
  t.after(() => fs.rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  const baseline = path.join(scratch, "baseline");
  let serial = 0;
  async function run(
    workspace: string | undefined,
    args: string[],
    input?: string,
    maximum?: number,
  ) {
    const trace = path.join(scratch, `trace-${serial++}.jsonl`);
    const result = spawnSync(
      process.execPath,
      [
        "--require",
        preload,
        "--import",
        "tsx",
        cli,
        ...args,
        ...(workspace ? ["--workspace", workspace, "--json"] : []),
      ],
      {
        input,
        encoding: "utf8",
        windowsHide: true,
        timeout: 90_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, TENT_REVIEW_TRACE: trace },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const records = (await fs.readFile(trace, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Trace);
    const starts = records.filter((row) => row.event === "start");
    for (const start of starts)
      assert.equal(records.find((row) => row.id === start.id && row.event === "close")?.code, 0);
    if (maximum !== undefined)
      assert.ok(
        starts.length <= maximum,
        `${args.join(" ")}: ${starts.length} Git processes, budget ${maximum}`,
      );
    const mirrors = starts.filter((row) => row.args?.includes("read-tree"));
    const unique = new Set(
      mirrors.map((row) =>
        JSON.stringify([row.args!.slice(row.args!.indexOf("read-tree")), row.indexFile]),
      ),
    );
    assert.equal(
      unique.size,
      mirrors.length,
      "same tree/index must not be read twice in one command",
    );
    return { value: workspace ? JSON.parse(result.stdout) : undefined, starts };
  }
  await run(undefined, ["new", baseline]);
  await fs.writeFile(path.join(baseline, "source.md"), "# Source\n\nFirst version.\n");
  await fs.writeFile(path.join(baseline, "result.txt"), "Observed result.\n");
  const prepared = (
    await run(
      baseline,
      ["node", "write-many", "--input-json", "-"],
      JSON.stringify({
        items: [
          { op: "create", ref: "goal", name: "Goal", type: "goal-requirement", body },
          {
            op: "create",
            ref: "prompt",
            name: "Prompt",
            parent: "@goal",
            type: "prompt-decision",
            body,
            sources: [{ resource: "source.md" }],
          },
          {
            op: "create",
            ref: "long",
            name: "Long",
            type: "prompt-reference",
            body: "Long line for pagination.\n".repeat(2400),
          },
        ],
      }),
    )
  ).value;
  const [goal, prompt, long] = prepared.results.map((row: { nodeId: string }) => row.nodeId);
  await run(baseline, ["workspace", "brief"]);
  for (const op of [
    "create",
    "append",
    "write",
    "write-section",
    "confirm",
    "link-output",
    "write-many",
  ]) {
    const workspace = path.join(scratch, op);
    await fs.cp(baseline, workspace, { recursive: true });
    let args: string[] = [],
      input: string | undefined;
    if (op === "create")
      args = ["node", "create", "Added", "--type", "prompt-decision", "--body", body];
    if (op === "append") args = ["node", "append", prompt, "--body", "Added fact."];
    if (op === "write" || op === "confirm") {
      const selected = (await run(workspace, ["node", "get", prompt, "--full"], undefined, 1)).value
        .node;
      args = ["node", op, prompt, "--base-etag", selected.etag];
      if (op === "write") args.push("--body", body + "Updated fact.\n");
      else await fs.appendFile(path.join(workspace, "source.md"), "Material changed.\n");
    }
    if (op === "write-section") {
      const section = (await run(workspace, ["node", "get-section", prompt, "--heading", "Alpha"]))
        .value;
      args = [
        "node",
        op,
        prompt,
        "--heading",
        "Alpha",
        "--base-etag",
        section.sectionEtag,
        "--body",
        "## Alpha\n\nChanged fact.\n",
      ];
    }
    if (op === "link-output")
      args = ["node", op, goal, "--resource", "result.txt", "--name", "Result"];
    if (op === "write-many") {
      args = ["node", op, "--input-json", "-"];
      input = JSON.stringify({
        items: Array.from({ length: 10 }, (_, i) => ({
          op: "create",
          ref: `new${i}`,
          name: `Batch${i}`,
          type: "prompt-decision",
          body,
        })),
      });
    }
    await run(workspace, args, input, 10);
  }
  for (const kind of ["summary", "body", "raw", "full", "range", "cursor"]) {
    const workspace = path.join(scratch, `get-${kind}`);
    await fs.cp(baseline, workspace, { recursive: true });
    const args = ["node", "get", kind === "cursor" ? long : prompt];
    if (["summary", "body", "raw"].includes(kind)) args.push("--view", kind);
    if (kind === "full") args.push("--full");
    if (kind === "range")
      args.push("--view", "body", "--range", JSON.stringify({ unit: "utf16", start: 0, end: 20 }));
    if (kind === "cursor") {
      const first = (await run(workspace, ["node", "get", long, "--view", "body"], undefined, 1))
        .value.node;
      assert.ok(first.page.nextCursor);
      args.push("--view", "body", "--expected-etag", first.etag, "--cursor", first.page.nextCursor);
    }
    await run(workspace, args, undefined, kind === "summary" ? 0 : 1);
  }
  await run(baseline, ["workspace", "brief"], undefined, 2);
  const selected = (await run(baseline, ["node", "get", prompt, "--full"], undefined, 1)).value
    .node;
  const note = path.join(baseline, ".tent", "Goal", "Prompt", "Prompt.md");
  await fs.appendFile(note, "Editor added these exact bytes.\n");
  const external = (await run(baseline, ["node", "get", prompt, "--full"])).value.node;
  assert.notEqual(external.etag, selected.etag);
  assert.notDeepEqual(external.version, selected.version);
  assert.match(external.text, /Editor added these exact bytes/);
  const cold = path.join(scratch, "cold-get");
  await fs.cp(baseline, cold, { recursive: true });
  await fs.rm(path.join(cold, ".tent", ".git", "tent-history-index.json"));
  const reread = (await run(cold, ["node", "get", prompt, "--full"])).value.node;
  assert.equal(reread.etag, external.etag);
  assert.deepEqual(reread.version, external.version);
});

test("NodeFs CLI, Core and UI wait for the owner; timeout preserves ownership and skips the action", async (t) => {
  await fs.mkdir(".scratch/node-mechanics", { recursive: true });
  const root = await fs.mkdtemp(path.resolve(".scratch/node-mechanics/lock-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const entry of ["cli", "core", "ui"] as const) {
    let ready!: () => void,
      release!: () => void,
      called = 0;
    const held = new Promise<void>((resolve) => (release = resolve));
    const acquired = new Promise<void>((resolve) => (ready = resolve));
    const owner = new NodeFs(root, "core").withLock("mutation.lock", async () => {
      ready();
      await held;
    });
    await acquired;
    const waiter = new NodeFs(root, entry).withLock("mutation.lock", async () => {
      called++;
    });
    await delay(100);
    assert.equal(called, 0);
    release();
    await owner;
    await waiter;
    assert.equal(called, 1);
  }
  const record = JSON.stringify({
    ownerToken: "live-owner",
    pid: process.pid,
    createdAt: new Date().toISOString(),
  });
  const lock = path.join(root, "mutation.lock");
  await fs.writeFile(lock, record);
  let called = false;
  const start = performance.now();
  await assert.rejects(
    new NodeFs(root, "core").withLock("mutation.lock", async () => {
      called = true;
    }),
    /after waiting 8 seconds.*reread before retrying/,
  );
  assert.ok(performance.now() - start >= 8_000);
  assert.equal(called, false);
  assert.equal(await fs.readFile(lock, "utf8"), record);
});
