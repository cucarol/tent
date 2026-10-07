import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptUrl = (name: string) => new URL(`../scripts/${name}`, import.meta.url).href;

async function readPinned() {
  const { parsePinned } = await import(scriptUrl("okf-upstream.mjs"));
  const raw = await fs.readFile(path.join(repoRoot, "docs", "upstream", "okf-SPEC.md"), "utf8");
  return parsePinned(raw) as { fields: Record<string, string>; body: string };
}

// 固定副本中代码块外的编号标题，如 "## 5. ..." 与 "### 5.4 ..."。
function sectionNumbers(body: string): Set<string> {
  const sections = new Set<string>();
  let fence: string | undefined;
  for (const line of body.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    const heading = fence ? undefined : /^#{1,6}\s+(\d+(?:\.\d+)*)\.?\s/.exec(line);
    if (heading) sections.add(heading[1]!);
  }
  return sections;
}

async function referenceDocuments(): Promise<string[]> {
  const files = ["docs/SPEC.md", "docs/PLUGIN.md"];
  for (const entry of await fs.readdir(path.join(repoRoot, "skills"), { withFileTypes: true })) {
    if (entry.isDirectory()) files.push(`skills/${entry.name}/SKILL.md`);
  }
  const references = path.join(repoRoot, "skill-resources", "references");
  for (const name of (await fs.readdir(references)).sort()) {
    if (name.endsWith(".md")) files.push(`skill-resources/references/${name}`);
  }
  return files;
}

test("OKF § references in public docs resolve to headings of the pinned upstream spec", async () => {
  const { fields, body } = await readPinned();
  const sections = sectionNumbers(body);
  assert.ok(sections.has("1") && sections.size > 10, "pinned spec exposes numbered headings");
  const reference =
    /\bOKF(?:\s+v(\d+(?:\.\d+)*))?\s+§\d+(?:\.\d+)*(?:\s*(?:,|\/|–|\band\b|\bor\b)\s*§\d+(?:\.\d+)*)*/g;
  let checked = 0;
  for (const file of await referenceDocuments()) {
    const lines = (await fs.readFile(path.join(repoRoot, file), "utf8")).split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const match of line.matchAll(reference)) {
        const where = `${file}:${index + 1} "${match[0]}"`;
        if (match[1]) assert.equal(match[1], fields["okf-version"], `${where} cites another OKF`);
        for (const [, section] of match[0].matchAll(/§(\d+(?:\.\d+)*)/g)) {
          assert.ok(sections.has(section!), `${where}: no §${section} in pinned OKF`);
          checked++;
        }
      }
    });
  }
  assert.ok(checked > 0, "public docs cite OKF sections");
});

test("pinned OKF spec is unmodified upstream text that drives okf-check", async () => {
  const { fields, body } = await readPinned();
  assert.equal(createHash("sha256").update(body).digest("hex"), fields.sha256);
  assert.equal(Buffer.byteLength(body), Number(fields.bytes));
  assert.ok(body.includes(`\n**Version ${fields["okf-version"]}**\n`));
  const { pinnedOkfSpec } = await import(scriptUrl("okf-check.mjs"));
  assert.deepEqual(pinnedOkfSpec(), { version: fields["okf-version"], source: fields.source });

  const { parsePinned, renderPinned, diffLines, SOURCE } = await import(
    scriptUrl("okf-upstream.mjs")
  );
  assert.equal(fields.source, SOURCE);
  const rendered = parsePinned(
    renderPinned({ commit: "abc", date: "2026-01-01T00:00:00Z", fetchedAt: "now", body }),
  );
  assert.equal(rendered.body, body);
  assert.equal(rendered.fields.sha256, fields.sha256);
  assert.deepEqual(diffLines(body, body), { changed: 0, added: 0, removed: 0, lines: [] });
  const drift = diffLines("a\nb\nc\nd", "a\nB\nc\nd\ne");
  assert.deepEqual(
    { changed: drift.changed, added: drift.added, removed: drift.removed },
    { changed: 1, added: 1, removed: 0 },
  );
  assert.deepEqual(drift.lines[0], { op: "-", line: 2, text: "b" });
});
