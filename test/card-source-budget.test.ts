import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { runCardCommand } from "../src/cli/card-commands.js";
import { runRoleCommand } from "../src/cli/role-commands.js";
import { parseFrontmatter } from "../src/core/base/frontmatter.js";
import { initializeFixtureWorkspace, testScratchRoot } from "./scratch.js";
import { removeTestFixture } from "./node-fs.js";

const json = (response: { exitCode: number; stdout: string; stderr: string }) => {
  assert.equal(response.exitCode, 0, response.stderr);
  return JSON.parse(response.stdout);
};
const textPage = (response: { exitCode: number; stdout: string; stderr: string }) => {
  assert.equal(response.exitCode, 0, response.stderr);
  const primary = response.stdout.split("\n\nAgent context\n")[0]!;
  assert.ok(Buffer.byteLength(primary) <= 8192, `${Buffer.byteLength(primary)} primary bytes`);
  assert.ok(Buffer.byteLength(response.stdout) <= 16384);
  assert.ok(response.stdout.includes("--view raw --workspace"));
  return primary;
};

for (const [label, title, count] of [
  ["long title", "R".repeat(9000), 1],
  ["many Unicode titles", "😀".repeat(9000), 18],
] as const) {
  test(`Card source display budgets ${label} through real CLI text and JSON`, async (t) => {
    const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "card-source-budget-"));
    t.after(() => removeTestFixture(workspace, { recursive: true, force: true }));
    // A separate repository and explicit workspace prevent upward scans into the project.
    await initializeFixtureWorkspace(workspace);
    const options = { workspace, cwd: workspace, json: true };
    const text = { workspace, cwd: workspace };
    json(
      await runRoleCommand(
        "create",
        ["--id", "role-wide", "--title", title, "--body", "Role instructions."],
        options,
      ),
    );
    const roleRaw = await fs.readFile(path.join(workspace, ".tent/roles/role-wide.md"), "utf8");
    assert.equal(parseFrontmatter(roleRaw).data.title, title);
    const created = json(
      await runCardCommand(
        "create",
        [
          "--id",
          "card-budget",
          "--prompt",
          "Read the pinned inputs.",
          ...Array.from({ length: count }, () => ["--source", ".tent/roles/role-wide.md"]).flat(),
        ],
        options,
      ),
    );
    const before = json(await runCardCommand("show", [created.cardId], options));
    assert.equal(before.sources.length, count);
    assert.ok(
      before.sources.every(
        (source: { version: { commit: string; path: string } }) =>
          /^[a-f0-9]{64}$/.test(source.version.commit) &&
          source.version.path === "roles/role-wide.md",
      ),
    );
    const shown = await runCardCommand("show", [created.cardId], text);
    const primary = textPage(shown);
    assert.ok(primary.includes("Read the pinned inputs."));
    assert.ok(primary.includes("[title truncated]"));
    assert.ok(!primary.includes(title));
    const summaries = [...primary.matchAll(/^  \d+\. (.+)$/gm)];
    assert.ok(summaries.length > 0);
    for (const line of summaries) {
      assert.ok(line[1]!.startsWith(".tent/roles/role-wide.md  Role "));
      assert.ok(line[1]!.includes(`  role-wide  @${before.sources[0].version.commit.slice(0, 7)}`));
    }
    const omitted = Number(/(\d+) source summaries omitted/.exec(primary)?.[1] ?? 0);
    assert.equal(summaries.length + omitted, count);
    assert.equal(omitted > 0, count > 1);
    assert.equal((await runCardCommand("show", [created.cardId], text)).stdout, shown.stdout);
    const again = json(await runCardCommand("show", [created.cardId], options));
    assert.deepEqual(again.sources, before.sources);
    assert.ok(Buffer.byteLength(JSON.stringify(again) + "\n") <= 16384);
    assert.equal("sourceDetails" in again, false);
    const raw = json(await runCardCommand("show", [created.cardId, "--view", "raw"], options));
    assert.equal(raw.agentContext, undefined);
    assert.deepEqual(raw.sources, before.sources);
    textPage(await runCardCommand("take", [created.cardId], text));
    const taken = json(await runCardCommand("take", [created.cardId], options));
    assert.ok(taken.agentContext);
    assert.deepEqual(taken.sources, before.sources);
    assert.equal(
      await fs.readFile(path.join(workspace, ".tent/roles/role-wide.md"), "utf8"),
      roleRaw,
    );
    console.log(
      JSON.stringify({
        case: label,
        sourceCount: count,
        shownSummaries: summaries.length,
        omitted,
        primaryBytes: Buffer.byteLength(primary),
        pageBytes: Buffer.byteLength(shown.stdout),
      }),
    );
  });
}
