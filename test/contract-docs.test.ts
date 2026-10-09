import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { deriveCardProgress } from "../src/core/card-progress.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => fs.readFile(path.join(repoRoot, file), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");

// Agent-facing text: every SKILL.md, the shared references and the tent-init Hook reference.
async function agentFacingFiles(): Promise<string[]> {
  const files = ["skills/tent-init/references/host-hooks.md"];
  for (const entry of await fs.readdir(path.join(repoRoot, "skills"), { withFileTypes: true }))
    if (entry.isDirectory()) files.push(`skills/${entry.name}/SKILL.md`);
  for (const name of await fs.readdir(path.join(repoRoot, "skill-resources", "references")))
    if (name.endsWith(".md")) files.push(`skill-resources/references/${name}`);
  return files.sort();
}

test("Agent-facing Skill text stays within its byte budget and links one level deep", async () => {
  let total = 0;
  for (const file of await agentFacingFiles()) {
    const text = await read(file);
    const bytes = Buffer.byteLength(text, "utf8");
    total += bytes;
    if (file.endsWith("/SKILL.md")) assert.ok(bytes <= 2000, `${file}: ${bytes} bytes`);
    assert.doesNotMatch(text, /Maintainer background|docs\/(?:PLUGIN|SPEC)\.md/, file);
    assert.doesNotMatch(text, /\\\|/, `${file} escapes a table pipe`);
    if (!file.endsWith("/SKILL.md"))
      assert.doesNotMatch(text, /\]\((?![a-z]+:)[^)]*\.md(?:#[^)]*)?\)/, `${file} links a file`);
  }
  assert.ok(total <= 12000, `Agent-facing Skill text is ${total} bytes`);
});

test("material paths are defined once, in node-maintenance", async () => {
  const maintenance = flat(await read("skill-resources/references/node-maintenance.md"));
  assert.match(
    maintenance,
    /Pass Workspace-root paths \(`docs\/x\.md`\); Tent stores them Node-relative/,
  );
  assert.match(maintenance, /`docs\/x\.md#State`/);
  const access = flat(await read("skill-resources/references/access.md"));
  assert.doesNotMatch(access, /relative to the Node's own file|Workspace-root path/);
  const cards = flat(await read("skill-resources/references/cards.md"));
  assert.match(
    cards,
    /`--source` takes a Node id or a Workspace-root path such as `docs\/req\.md`/,
  );
  assert.doesNotMatch(cards, /`\.\/docs\/req\.md`|`\/docs\/req\.md`/);
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

test("type guidance names exactly three types and the preset tags", async () => {
  const formerTypes =
    /\b(goal|prompt|output)-(direction|requirement|decision|spec|reference|procedure|asset|evidence|analysis|issue)\b|NODE_TYPE_PRESETS|implementing it/;
  const spec = flat(await read("docs/SPEC.md"));
  assert.match(spec, /a Node has one `type`, exactly `goal`, `prompt` or `output`/);
  assert.match(
    spec,
    /A goal without any active `output` anywhere in its subtree is ahead; tags do not change this/,
  );
  assert.doesNotMatch(spec, formerTypes);
  const types = await read("skill-resources/references/node-types.md");
  for (const type of ["goal", "prompt", "output"])
    assert.match(types, new RegExp(`^\\| \`${type}\` \\|`, "m"), type);
  // The suggested tag vocabulary, NODE_TAG_PRESETS in Core.
  for (const tag of [
    "direction",
    "requirement",
    "decision",
    "spec",
    "reference",
    "procedure",
    "asset",
    "evidence",
    "analysis",
    "issue",
  ])
    assert.match(types, new RegExp(`^\\| \`${tag}\` \\|`, "m"), tag);
  assert.match(flat(types), /Every current `output` under a goal counts as its result/);
  assert.match(flat(types), /from `tent node tags`/);
  assert.doesNotMatch(types, formerTypes);
  assert.doesNotMatch(types, /an `output` counts as implementing it/);
  const skill = flat(await read("skills/tent-node/SKILL.md"));
  assert.doesNotMatch(skill, formerTypes);
  assert.doesNotMatch(skill, /only results that implement it are `output`/);
  for (const file of await agentFacingFiles())
    assert.doesNotMatch(await read(file), /\b(?:goal|prompt|output)-(?!id\b)[a-z]+/, file);
});

test("goal and prompt materials exclude src code, which belongs in body links or outputs", async () => {
  const text = flat(await read("skill-resources/references/node-maintenance.md"));
  assert.match(text, /A `goal` or `prompt` takes its grounds as material, not code/);
  const plugin = flat(await read("docs/PLUGIN.md"));
  assert.match(plugin, /不以 `src\/` 下代码为材料/);
  assert.match(plugin, /\[Codex Hooks\]\(https:\/\/learn\.chatgpt\.com\/docs\/hooks\)/);
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
  // The CLI reports a rejected name; the rule lives in SPEC and the maintainer guide.
  const plugin = flat(await read("docs/PLUGIN.md"));
  assert.match(plugin, /`COM1`–`COM9`、`LPT1`–`LPT9`、`COM¹`–`COM³`、`LPT¹`–`LPT³`/);
  assert.match(
    spec,
    /fails while Tent Git HEAD is still the commit read after the move, the rename is rolled back/,
  );
  assert.match(spec, /or Tent Git cannot show whether it does, the disk keeps the new name/);
  assert.match(spec, /`node-git-mismatch` names a Node identity document/);
  assert.match(spec, /`card create` warns on stderr, without changing what it stores/);
});
