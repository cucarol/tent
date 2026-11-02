import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => fs.readFile(path.join(repoRoot, file), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");

// Agent-facing text: every SKILL.md, the shared references and each host's own references.
async function agentFacingFiles(): Promise<string[]> {
  const files = [
    "plugins/codex/tent/host-hooks.md",
    "plugins/claude-code/tent/host-hooks.md",
    "plugins/codex/tent/host-role.md",
    "plugins/claude-code/tent/host-role.md",
    "skills/tent-init/references/map.md",
  ];
  for (const entry of await fs.readdir(path.join(repoRoot, "skills"), { withFileTypes: true }))
    if (entry.isDirectory()) files.push(`skills/${entry.name}/SKILL.md`);
  for (const name of await fs.readdir(path.join(repoRoot, "skill-resources", "references")))
    if (name.endsWith(".md")) files.push(`skill-resources/references/${name}`);
  return files.sort();
}

test("each host's Agent documents follow official Skill limits and reference depth", async () => {
  const { validateSourceDocuments } = await import(
    new URL("../scripts/validate-plugin.mjs", import.meta.url).href
  );
  for (const host of ["codex", "claude-code"]) await validateSourceDocuments(repoRoot, host);
});

test("Skill validation follows Markdown semantics and rejects actual nested references", async () => {
  const { validateDocuments } = await import(
    new URL("../scripts/validate-plugin.mjs", import.meta.url).href
  );
  const skill =
    '---\nname: example\ndescription: "Reads useful context. Use when context is needed."\n---\n';
  const file = "skills/example/SKILL.md",
    reference = "skills/example/references/one.md";
  const documents = new Map([
    [file, skill + "[Read][guide]\n\n[guide]: references/one.md"],
    [reference, "Example: `[Node](other.md)`\n\n```md\n[Node](other.md)\n```"],
  ]);
  validateDocuments(documents);
  documents.set(reference, "[Next][other]\n\n[other]: two.md");
  assert.throws(() => validateDocuments(documents), /references must not link/);
  documents.set(reference, "# Guide\n" + "line\n".repeat(100));
  assert.throws(() => validateDocuments(documents), /table of contents/);
  documents.set(
    reference,
    "# Guide\n\n- [Details][contents]\n\n[contents]: #details\n\n## Details\n" +
      "line\n".repeat(100),
  );
  validateDocuments(documents);
  documents.set(file, skill + "line\n".repeat(500));
  assert.throws(() => validateDocuments(documents), /below 500/);
  documents.set(file, skill.replace("name: example", "name: Example"));
  assert.throws(() => validateDocuments(documents), /name must use/);
  documents.set(file, skill.replace("Reads useful context.", "Use this to read context."));
  assert.throws(() => validateDocuments(documents), /third person/);
  documents.set(file, skill.replace("Reads useful context.", "Reads " + "x".repeat(1024)));
  assert.throws(() => validateDocuments(documents), /1024/);
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

test("PLUGIN.md points to SPEC for results and brief rules", async () => {
  const spec = flat(await read("docs/SPEC.md"));
  const plugin = await read("docs/PLUGIN.md");
  assert.match(spec, /## 4\. Results/);
  assert.match(
    spec,
    /`node link-output <goal-id> --resource <address>` creates an output under a goal/,
  );
  assert.doesNotMatch(
    spec,
    /comparison bases|intent basis|changedSince|node confirm|node check|workspace drift|--confirm/,
  );
  assert.match(
    spec,
    /`workspace brief \[--role <role>\]` first collects native edits, then reports within 16 KiB/,
  );
  assert.match(
    spec,
    /up to ten recently changed Nodes.*up to ten of the Role's unfinished Cards.*up to ten workspace problems/,
  );
  assert.match(spec, /titles can be shortened, ids never are/);
  assert.match(plugin, /SPEC\.md#Brief/);
  assert.match(plugin, /SPEC\.md#5\.%20What%20the%20Agent%20is%20told/);
  assert.match(plugin, /SPEC\.md#6\.%20What%20a%20reader%20gets/);
  assert.doesNotMatch(plugin, /最近的 goal 祖先提供隐式来源/);
  assert.doesNotMatch(plugin, /四种同步状态计数/);
  assert.doesNotMatch(plugin, /按 4 KiB 预算裁剪|待收回结果不省略/);
});

test("type guidance names exactly three types and the preset tags", async () => {
  const formerTypes =
    /\b(goal|prompt|output)-(direction|requirement|decision|spec|reference|procedure|asset|evidence|analysis|issue)\b|NODE_TYPE_PRESETS|implementing it/;
  const spec = flat(await read("docs/SPEC.md"));
  assert.match(spec, /`type` is exactly `goal`, `prompt` or `output`/);
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
  assert.match(flat(types), /Keep the goal's open questions in `prompt` Nodes/);
  assert.match(flat(types), /from `tent node tags`/);
  assert.doesNotMatch(types, formerTypes);
  assert.doesNotMatch(types, /an `output` counts as implementing it/);
  const skill = flat(await read("skills/tent-node/SKILL.md"));
  assert.doesNotMatch(skill, formerTypes);
  assert.doesNotMatch(skill, /only results that implement it are `output`/);
  for (const file of await agentFacingFiles())
    assert.doesNotMatch(await read(file), /\b(?:goal|prompt|output)-(?!id\b)[a-z]+/, file);
});

test("goal material guidance distinguishes intent grounds from implementation coverage", async () => {
  const text = flat(await read("skill-resources/references/node-maintenance.md"));
  assert.match(text, /A `goal` or `prompt` takes its grounds as material, not code/);
  assert.match(text, /a `goal` may still own the code that carries it out\./);
  const plugin = flat(await read("docs/PLUGIN.md"));
  assert.match(plugin, /`goal` 与 `prompt` 用材料指明意图和规则的依据/);
  assert.doesNotMatch(plugin, /不以 `src\/` 下代码为材料/);
  assert.match(plugin, /\[Codex Hooks\]\(https:\/\/learn\.chatgpt\.com\/docs\/hooks\)/);
});

test("Card contract gives delivery state one completion source independent of goal progress", async () => {
  const spec = flat(await read("docs/SPEC.md"));
  assert.match(spec, /returnTo/);
  assert.match(spec, /`pending`.*`consumed`.*`returned`.*`closed`/);
  assert.match(
    spec,
    /Without `returnTo`, consumed means complete; with it, returned means complete/,
  );
  assert.match(
    spec,
    /A Card shows delivery state only: no progress, goal counts or output lists are derived from it/,
  );
  assert.doesNotMatch(
    spec,
    /progress is `needs-review`|progress is `received-no-output`|`progress: null`/,
  );
  const plugin = flat(await read("docs/PLUGIN.md"));
  assert.match(plugin, /`pending`.*`consumed`.*`returned`.*`closed`/);
  assert.match(plugin, /`card return <id> --role <role-id> --result TEXT`/);
  assert.doesNotMatch(
    plugin,
    /received-no-output|needs-review|has-output|goalCount|totalGoalCount/,
  );
});

test("SPEC records the Node name, rename rollback, check and Card warning contracts", async () => {
  const spec = flat(await read("docs/SPEC.md"));
  assert.match(spec, /Names must be valid Windows file names on every platform/);
  assert.match(
    spec,
    /`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, `COM¹`–`COM³` and `LPT¹`–`LPT³`, with or without an extension/,
  );
  assert.match(
    spec,
    /C0 control characters \(U\+0000–U\+001F\), DEL \(U\+007F\), U\+2028, U\+2029 and the reserved device names/,
  );
  // The CLI reports a rejected name; the rule lives in SPEC and the maintainer guide.
  const plugin = flat(await read("docs/PLUGIN.md"));
  assert.match(plugin, /`COM1`–`COM9`、`LPT1`–`LPT9`、`COM¹`–`COM³`、`LPT¹`–`LPT³`/);
  assert.match(spec, /settles an interrupted write to all old or all new before it reads anything/);
  assert.match(spec, /Node files that disagree with retained history \(`node-git-mismatch`\)/);
  assert.match(spec, /`card create` warns on stderr, without changing what it stores/);
});
