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

test("Node guidance distinguishes stored document paths from CLI Workspace paths", async () => {
  const maintenance = flat(await read("skills/tent-node/SKILL.md"));
  assert.match(
    maintenance,
    /`--resource` and `--source` take Workspace-root paths.*Tent stores them relative to the Node file/,
  );
  assert.match(maintenance, /Paths are relative to the Node file/);
  assert.match(maintenance, /docs\/login\.md#Codes/);
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
  assert.match(spec, /`node create --type output`/);
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
  assert.match(plugin, /SPEC\.md#brief/);
  assert.match(plugin, /SPEC\.md#5-what-the-agent-is-told/);
  assert.doesNotMatch(plugin, /最近的 goal 祖先提供隐式来源/);
  assert.doesNotMatch(plugin, /四种同步状态计数/);
  assert.doesNotMatch(plugin, /按 4 KiB 预算裁剪|待收回结果不省略/);
});

test("Node guidance keeps the required type names and ordinary metadata without type behavior", async () => {
  const spec = flat(await read("docs/SPEC.md"));
  const skill = await read("skills/tent-node/SKILL.md");
  assert.match(spec, /`type` is required and is exactly `goal`, `prompt` or `output`/);
  assert.match(spec, /same coverage, reading and writing behavior/);
  assert.match(skill, /`goal`, `prompt` or `output`, as the word says/);
  for (const field of ["id", "type", "description", "tags", "resource", "sources", "status"])
    assert.ok(skill.includes(`| \`${field}\` |`), field);
  const { NODE_TAG_PRESETS } = await import("../src/core/base/tags.js");
  for (const tag of NODE_TAG_PRESETS) assert.ok(spec.includes(`\`${tag}\``), tag);
  for (const file of await agentFacingFiles()) {
    const text = await read(file);
    assert.doesNotMatch(text, /\b(?:goal|prompt|output)-(?!id\b)[a-z]+/, file);
    assert.doesNotMatch(
      text,
      /tent node (?:get|list|read-many|search|relations|tags|append|write|write-many|link-output)(?:[ \`]|$)/,
      file,
    );
  }
});

test("Stop and host guidance use file pointers without rule inheritance or ownership", async () => {
  const spec = await read("docs/SPEC.md");
  const notice =
    "Files changed this turn are covered by these Tent Nodes:\n- <name>: <absolute path>\nIf the change made a sentence in them wrong, fix it; if it settled something lasting, record it; otherwise say nothing about Tent.";
  assert.ok(spec.includes(notice));
  assert.ok(spec.includes("These Tent Node files have problems:\n- <absolute path>: <problem>"));
  for (const host of ["codex", "claude-code"])
    assert.ok(
      (await read(`plugins/${host}/tent/host-hooks.md`)).includes(
        "Files changed this turn are covered by these Tent Nodes:",
      ),
    );
  const hooks = spec.slice(spec.indexOf("### Hooks"), spec.indexOf("## 6."));
  assert.match(hooks, /Both plugins register only Stop/);
  assert.doesNotMatch(hooks, /SessionStart|UserPromptSubmit|PostToolUse|1600|8 KiB/);
  const plugin = flat(await read("docs/PLUGIN.md"));
  assert.match(plugin, /没有 `track` 或代码所有权，也不按 type 继承规则/);
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
