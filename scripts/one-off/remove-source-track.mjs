import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { CST, isAlias, isMap, isSeq, parseDocument, stringify } from "yaml";

// Offline removal of current Node verified and source track fields. History stays intact.
export function removeSourceTrack(raw) {
  const opening = /^(?:\uFEFF)?---[^\S\r\n]*(?:\r?\n)/.exec(raw);
  if (!opening) return raw;
  const rest = raw.slice(opening[0].length);
  const closing = /^---[^\S\r\n]*(?:\r?\n|$)/m.exec(rest);
  if (!closing) throw new Error("Unterminated Node frontmatter");
  const yaml = rest.slice(0, closing.index);
  const document = parseDocument(yaml, { keepSourceTokens: true });
  if (document.errors.length)
    throw new Error(document.errors.map((error) => error.message).join("; "));
  if (!isMap(document.contents)) return raw;
  const sources = document.get("sources", true);
  const expected = document.toJS();
  const edits = [];
  if (document.has("verified")) {
    const token = structuredClone(document.contents.srcToken);
    const original = CST.stringify(token);
    const removed = document.contents.items.findIndex((pair) => pair.key?.value === "verified");
    const firstStart = token.items[0].start;
    token.items.splice(removed, 1);
    if (removed === 0 && token.items.length) token.items[0].start = firstStart;
    const replacement = CST.stringify(token);
    let start = 0,
      end = 0;
    while (
      start < original.length &&
      start < replacement.length &&
      original[start] === replacement[start]
    )
      start++;
    while (
      end < original.length - start &&
      end < replacement.length - start &&
      original[original.length - 1 - end] === replacement[replacement.length - 1 - end]
    )
      end++;
    edits.push({
      start: document.contents.srcToken.offset + start,
      end: document.contents.srcToken.offset + original.length - end,
      replacement: replacement.slice(start, replacement.length - end),
    });
    delete expected.verified;
  }
  if (isSeq(sources))
    expected.sources = expected.sources.map((source) =>
      source && typeof source === "object" && !Array.isArray(source) ? { ...source } : source,
    );
  for (let index = 0; index < (isSeq(sources) ? sources.items.length : 0); index++) {
    const source = sources.items[index];
    if (isAlias(source)) {
      const resolved = source.resolve(document);
      if (isMap(resolved) && resolved.has("track")) {
        if (!resolved.has("resource")) throw new Error("Source with track has no resource");
        delete expected.sources[index].track;
        edits.push({
          start: source.range[0],
          end: source.range[1],
          replacement: stringify(expected.sources[index], {
            collectionStyle: "flow",
            lineWidth: 0,
          }).trimEnd(),
        });
      }
      continue;
    }
    if (!isMap(source) || !source.has("track")) continue;
    if (!source.has("resource")) throw new Error("Source with track has no resource");
    const token = structuredClone(source.srcToken);
    const original = CST.stringify(token);
    const removed = source.items.findIndex((pair) => pair.key?.value === "track");
    const firstStart = token.items[0].start;
    token.items.splice(removed, 1);
    if (removed === 0) token.items[0].start = firstStart;
    const replacement = CST.stringify(token);
    edits.push({
      start: source.srcToken.offset,
      end: source.srcToken.offset + original.length,
      replacement,
    });
    delete expected.sources[index].track;
  }
  if (!edits.length) return raw;
  let next = yaml;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    next = next.slice(0, edit.start) + edit.replacement + next.slice(edit.end);
  const checked = parseDocument(next);
  if (checked.errors.length || !isDeepStrictEqual(checked.toJS(), expected))
    throw new Error("Retired field removal changed other frontmatter values");
  return opening[0] + next + rest.slice(closing.index);
}

export async function convertWorkspace(workspaceRoot, apply = false) {
  const root = path.resolve(workspaceRoot, ".tent");
  const edits = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || [".git", "temp", "cards", "roles", ".tent"].includes(entry.name))
        continue;
      const child = path.join(directory, entry.name);
      const filename = path.join(child, entry.name + ".md");
      let raw;
      try {
        raw = await fs.readFile(filename, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (raw !== undefined) {
        const next = removeSourceTrack(raw);
        if (next !== raw) edits.push({ filename, raw, next });
      }
      await visit(child);
    }
  }
  await visit(root);
  if (apply) {
    for (const edit of edits)
      if ((await fs.readFile(edit.filename, "utf8")) !== edit.raw)
        throw new Error(`Node changed during conversion: ${edit.filename}`);
    for (const edit of edits) await fs.writeFile(edit.filename, edit.next);
  }
  return edits.map((edit) => path.relative(root, edit.filename).split(path.sep).join("/"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const roots = args.filter((arg) => arg !== "--apply");
  if (roots.length !== 1)
    throw new Error(
      "Usage: node scripts/one-off/remove-source-track.mjs <workspaceRoot> [--apply]",
    );
  const changed = await convertWorkspace(roots[0], apply);
  process.stdout.write(JSON.stringify({ apply, changed }) + "\n");
}
