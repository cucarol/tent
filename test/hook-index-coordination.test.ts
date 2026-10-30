import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { runRoleCommand } from "../src/cli/role-commands.js";
import { runToolHook } from "../src/cli/tool-hook.js";
import { observeTentSystemRoot } from "../src/core/workspace/status.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { readMutationLockRecord } from "../src/fs/mutation-lock.js";
import { loadStopMaterialIndex } from "../src/fs/stop-material-index.js";
import { initializeTentWorkspace } from "../src/fs/workspace-init.js";
import { withFileReadScope } from "../src/fs/file-state-cache.js";
import { removeTestFixture } from "./node-fs.js";
import { initializeFixtureRepository, testScratchRoot } from "./scratch.js";

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "index-coordination-"));
  initializeFixtureRepository(root);
  assert.equal((await observeTentSystemRoot(root)).systemRoot, undefined);
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  await initializeTentWorkspace(root);
  const system = path.join(root, ".tent");
  const cache = path.join(system, ".git/tent-material-cache/stop-material-index.json");
  const lock = path.join(system, "mutation.lock");
  const cli = async (op: string, args: string[]) => {
    const result = await runNodeCommand(op, args, { workspace: root, json: true });
    assert.equal(result.exitCode, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const tool = (files: string[], turn: string) =>
    runToolHook("codex", {
      hook_event_name: "PostToolUse",
      cwd: root,
      session_id: "coordination",
      turn_id: turn,
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** End Patch" },
      tool_response:
        "Success. Updated the following files:\n" +
        files.map((file) => "M " + file + "\n").join(""),
    });
  for (const [name, id, directory] of [
    ["A", "node-racea", "old-a"],
    ["B", "node-raceb", "old-b"],
  ]) {
    await fs.mkdir(path.join(root, directory!));
    await cli("create", [
      name!,
      "--type",
      "prompt",
      "--id",
      id!,
      "--sources-json",
      JSON.stringify([{ resource: directory + "/", track: "structure" }]),
    ]);
  }
  return { root, system, cache, lock, cli, tool };
}

function observeBusyRead(t: TestContext, lock: string, observed: () => void) {
  const read = fs.readFile.bind(fs);
  const mock = t.mock.method(fs, "readFile", (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]) === lock) observed();
    return read(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
  });
}

for (const publisher of ["native", "authoritative"] as const)
  test(
    `${publisher} preparation cannot cross a completed authoritative batch`,
    { timeout: 20_000 },
    async (t) => {
      const f = await fixture(t);
      await fs.mkdir(path.join(f.root, "new-a"));
      await fs.mkdir(path.join(f.root, "new-b"));
      const a = await f.cli("get", ["node-racea", "--full"]);
      const b = await f.cli("get", ["node-raceb", "--full"]);
      await fs.unlink(f.cache);
      const releaseB = signal(),
        busy = signal();
      let observingWriter = false,
        injected = false;
      let writer: Promise<unknown> | undefined;
      let scanOwner: Awaited<ReturnType<typeof readMutationLockRecord>> = null;
      const observations: string[] = [];
      const scanAdapter = publisher === "authoritative" ? new NodeFs(f.system) : undefined;
      if (scanAdapter) t.after(() => scanAdapter.close());
      observeBusyRead(t, f.lock, () => {
        if (observingWriter) busy.resolve();
      });
      const original = NodeFs.prototype.readFrontmatterObservation;
      t.mock.method(
        NodeFs.prototype,
        "readFrontmatterObservation",
        async function (this: NodeFs, file: string) {
          const scanning =
            publisher === "native"
              ? this.constructor.name === "NativeGraphIndexFs"
              : this === scanAdapter;
          if (scanning && file === "A/A.md" && !injected) {
            injected = true;
            const before = await original.call(this, file);
            observations.push(before.content);
            scanOwner = await readMutationLockRecord(f.lock);
            observingWriter = true;
            writer = f.cli("write-many", [
              "--input-json",
              JSON.stringify({
                items: [
                  {
                    op: "update",
                    nodeId: "node-racea",
                    baseEtag: a.etag,
                    frontmatter: { sources: [{ resource: "new-a/", track: "structure" }] },
                  },
                  {
                    op: "update",
                    nodeId: "node-raceb",
                    baseEtag: b.etag,
                    frontmatter: { sources: [{ resource: "new-b/", track: "structure" }] },
                  },
                ],
              }),
            ]);
            // With coordination the real writer is queued. On the old implementation
            // let it finish before B reads, reproducing the independent mixed snapshot.
            if (scanOwner) await busy.promise;
            else await writer;
            releaseB.resolve();
            return before;
          }
          if (scanning && file === "B/B.md") await releaseB.promise;
          return original.call(this, file);
        },
      );
      if (publisher === "native") assert.equal(await f.tool([".tent/A/A.md"], "graph"), "{}\n");
      else await loadStopMaterialIndex(f.system, f.root, [], scanAdapter);
      const receipt = await writer;
      assert.equal(injected, true);
      assert.ok(scanOwner, "the snapshot/publication must hold the actual canonical writer lock");
      const final = JSON.parse(await fs.readFile(f.cache, "utf8"));
      const coverage = final.index.nodes.map(
        (node: { nodeId: string; moduleCoverage: unknown }) => [node.nodeId, node.moduleCoverage],
      );
      assert.deepEqual(coverage, [
        ["node-racea", [{ kind: "directory", prefix: "new-a/" }]],
        ["node-raceb", [{ kind: "directory", prefix: "new-b/" }]],
      ]);
      const output = {
        oldA: await f.tool(["old-a/x.ts"], "old-a"),
        newA: await f.tool(["new-a/x.ts"], "new-a"),
        oldB: await f.tool(["old-b/x.ts"], "old-b"),
        newB: await f.tool(["new-b/x.ts"], "new-b"),
      };
      assert.doesNotMatch(output.oldA, /node-racea/);
      assert.doesNotMatch(output.oldB, /node-raceb/);
      assert.match(output.newA, /node-racea/);
      assert.match(output.newB, /node-raceb/);
      t.diagnostic(
        JSON.stringify({
          publisher,
          root: f.root,
          scanOwner,
          observations,
          receipt,
          coverage,
          output,
        }),
      );
    },
  );

test(
  "native refresh waits for a real non-graph Role writer and then prepares new coverage",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    const held = signal(),
      release = signal(),
      busy = signal();
    t.after(() => release.resolve());
    const write = NodeFs.prototype.writeFile;
    t.mock.method(
      NodeFs.prototype,
      "writeFile",
      async function (this: NodeFs, file: string, content: string) {
        await write.call(this, file, content);
        if (file.startsWith("roles/")) {
          held.resolve();
          await release.promise;
        }
      },
    );
    const holder = runRoleCommand(
      "create",
      ["--title", "Held role", "--body", "non-graph holder"],
      { workspace: f.root, json: true },
    );
    await held.promise;
    const before = await fs.readFile(f.cache);
    const file = path.join(f.system, "A/A.md");
    await fs.writeFile(
      file,
      (await fs.readFile(file, "utf8")).replace("../../old-a/", "../../new-a/"),
    );
    observeBusyRead(t, f.lock, busy.resolve);
    let finished = false;
    const refresh = f.tool([".tent/A/A.md"], "graph").then((output) => {
      finished = true;
      return output;
    });
    await busy.promise;
    assert.equal(finished, false);
    assert.deepEqual(await fs.readFile(f.cache), before);
    release.resolve();
    const result = await holder;
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(await refresh, "{}\n");
    assert.match(await f.tool(["new-a/x.ts"], "source"), /node-racea/);
    t.diagnostic(
      JSON.stringify({
        root: f.root,
        role: JSON.parse(result.stdout),
        waitedForNonGraphWriter: true,
      }),
    );
  },
);

test("shared preparation discards directory observations from before lock acquisition", async (t) => {
  const f = await fixture(t);
  const adapter = new NodeFs(f.system);
  t.after(() => adapter.close());
  await withFileReadScope(async () => {
    await adapter.listDir("");
    await fs.mkdir(path.join(f.system, "C"));
    await fs.writeFile(
      path.join(f.system, "C/C.md"),
      "---\nid: node-newc\ntype: prompt\n---\nNew graph input\n",
    );
    const index = await loadStopMaterialIndex(f.system, f.root, [], adapter);
    assert.ok(index.nodes.some((node) => node.nodeId === "node-newc"));
  });
});
