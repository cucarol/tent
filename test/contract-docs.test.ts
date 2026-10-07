import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { deriveCardProgress } from "../src/core/card-progress.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => fs.readFile(path.join(repoRoot, file), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");

test("path references separate Workspace-root CLI arguments from stored addresses", async () => {
  for (const file of [
    "skill-resources/references/node-maintenance.md",
    "skill-resources/references/access.md",
  ]) {
    const text = flat(await read(file));
    assert.match(text, /\*\*CLI arguments\*\*[^*]* resolve from the Workspace root/, file);
    assert.match(text, /\*\*Stored documents\*\*[^*]*Tent rewrites CLI paths/, file);
    assert.match(text, /`\.\/docs\/x\.md`|`\.\/src\/app\.ts`/, file);
    assert.doesNotMatch(text, /Paths are relative to the Node's own file/, file);
    assert.doesNotMatch(text, /## Paths in documents/, file);
  }
  for (const file of ["skills/tent-card/SKILL.md", "skill-resources/references/cards.md"])
    assert.match(flat(await read(file)), /Workspace[- ]root/, file);
});

test("PLUGIN.md matches SPEC goal ancestry and brief counts", async () => {
  const spec = flat(await read("docs/SPEC.md"));
  const plugin = await read("docs/PLUGIN.md");
  assert.match(spec, /An output depends on every goal ancestor/);
  assert.match(spec, /Its first line reports only behind and ahead counts/);
  assert.match(plugin, /全部 goal 祖先都提供隐式来源/);
  assert.doesNotMatch(plugin, /最近的 goal 祖先提供隐式来源/);
  assert.match(plugin, /落后与领先两种同步状态计数/);
  assert.doesNotMatch(plugin, /四种同步状态计数/);
});

test("type guidance counts only assets and evidence as goal implementation", async () => {
  const spec = flat(await read("docs/SPEC.md"));
  assert.match(spec, /Only `output-asset` and `output-evidence` count as implementation results/);
  const types = flat(await read("skill-resources/references/node-types.md"));
  assert.match(
    types,
    /Under a goal, only `output-asset` and `output-evidence` count as implementing it; an `output-issue` or `output-analysis` can sit under a goal without counting/,
  );
  assert.doesNotMatch(types, /an `output` counts as implementing it/);
  const skill = flat(await read("skills/tent-node/SKILL.md"));
  assert.match(
    skill,
    /Under a goal, only `output-asset` and `output-evidence` count as implementing it; `output-issue` and `output-analysis` can sit there without counting/,
  );
  assert.doesNotMatch(skill, /only results that implement it are `output`/);
});

test("goal and prompt materials exclude src code, which belongs in body links or outputs", async () => {
  const text = flat(await read("skill-resources/references/node-maintenance.md"));
  assert.match(text, /A `goal` or `prompt` does not take code files under `src\/` as materials/);
  assert.match(text, /link it in the body; to track one, put it in the `resource` of an output/);
});

test("Card progress is null when every requested goal is deprecated, even while pending", async () => {
  const spec = flat(await read("docs/SPEC.md"));
  assert.match(
    spec,
    /When every goal pinned by a Card's sources is deprecated, `progress` is also null, for a pending Card as well as a received one/,
  );
  for (const state of ["pending", "consumed"] as const)
    assert.equal(deriveCardProgress(state, 0).progress, null, state);
  assert.equal(deriveCardProgress("pending", 1).progress, "pending");
});

test("SPEC records the Node name, rename rollback, check and Card warning contracts", async () => {
  const spec = flat(await read("docs/SPEC.md"));
  assert.match(spec, /Names must be portable Windows file names on every platform/);
  assert.match(
    spec,
    /`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, `COM¹`, `COM²`, `COM³`, `LPT¹`, `LPT²` and `LPT³` in any case, with or without an extension/,
  );
  assert.match(
    spec,
    /The raw input is rejected if it contains a C0 control character \(U\+0000–U\+001F, including tab, CR and LF\), DEL \(U\+007F\), U\+2028 or U\+2029, even at either end; leading and trailing whitespace as JavaScript `trim\(\)` defines it is then removed\. C1 controls \(U\+0080–U\+009F\) are not rejected/,
  );
  const maintenance = flat(await read("skill-resources/references/node-maintenance.md"));
  assert.match(
    maintenance,
    /`COM1`–`COM9`, `LPT1`–`LPT9`, `COM¹`–`COM³` or `LPT¹`–`LPT³` in any case, with or without an extension/,
  );
  assert.match(
    spec,
    /fails while Tent Git HEAD is still the commit read after the move, the rename is rolled back/,
  );
  assert.match(spec, /or Tent Git cannot show whether it does, the disk keeps the new name/);
  assert.match(spec, /`node-git-mismatch` names a Node identity document/);
  assert.match(spec, /`card create` warns on stderr, without changing what it stores/);
});
