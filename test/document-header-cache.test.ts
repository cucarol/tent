import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
  parseFrontmatter,
  serializeFrontmatter,
  validFrontmatterCache,
  withFrontmatterCache,
} from "../src/core/base/frontmatter.js";
import { withDocumentHeaderCache } from "../src/fs/document-header-cache.js";
import { contentEtag } from "../src/core/base/etag.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { git } from "./helpers.js";
import { testScratchRoot } from "./scratch.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "header-cache-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  return root;
}

const prefix =
  "\uFEFF---\r\n# keep comment\r\n'2': two\r\n'1': one\r\nbase: &base {n: -0}\r\ncopy: *base\r\n---\r\n";

test("warm header parses isolate mutations while preserving aliases, -0 and serialization", async () => {
  const cold = await withFrontmatterCache(new Map(), async () => parseFrontmatter(prefix + "old"));
  const entry = cold.used.get(contentEtag(prefix))!;
  assert.ok(entry);
  const warm = await withFrontmatterCache(cold.used, async () => {
    const parsed = parseFrontmatter(prefix + "new body");
    assert.deepEqual(parsed.keyOrder, ["2", "1", "base", "copy"]);
    assert.equal(parsed.body, "new body");
    assert.equal(parsed.data.base, parsed.data.copy);
    assert.ok(Object.is((parsed.data.base as { n: number }).n, -0));
    assert.equal(
      serializeFrontmatter(parsed.data, parsed.body, parsed.keyOrder),
      prefix + "new body",
    );
    const changed = serializeFrontmatter({ ...parsed.data, extra: true }, "new", parsed.keyOrder);
    const uncached = serializeFrontmatter(
      { ...cold.result.data, extra: true },
      "new",
      cold.result.keyOrder,
    );
    assert.equal(changed, uncached);
    assert.throws(
      () => serializeFrontmatter({ ...parsed.data, base: { n: 2 } }, "", parsed.keyOrder),
      /Invalid frontmatter YAML/,
    );
    (parsed.data.base as { n: number }).n = 4;
    parsed.keyOrder.reverse();
    const again = parseFrontmatter(prefix + "another body");
    assert.ok(Object.is((again.data.base as { n: number }).n, -0));
    assert.deepEqual(again.keyOrder, ["2", "1", "base", "copy"]);
    return again;
  });
  assert.equal(warm.used.get(contentEtag(prefix)), entry);
  assert.ok(Object.is((cold.result.data.base as { n: number }).n, -0));
});

test("changed header bytes and invalid YAML never reuse an earlier parse", async () => {
  const cold = await withFrontmatterCache(new Map(), async () => parseFrontmatter(prefix + "body"));
  const next = await withFrontmatterCache(cold.used, async () => {
    assert.equal(parseFrontmatter(prefix.replace("two", "TWO") + "body").data["2"], "TWO");
    for (const yaml of ["x: 1\nx: 2", "x: [unfinished", "x: *missing", "x: .nan"])
      assert.throws(() => parseFrontmatter(`---\n${yaml}\n---\n`), /Invalid frontmatter YAML/);
    assert.throws(() => parseFrontmatter("---\nx: 1\n"), /unterminated frontmatter fence/);
    assert.equal(parseFrontmatter("plain body").body, "plain body");
  });
  assert.equal(next.used.size, 1);
  assert.equal(next.used.has(contentEtag(prefix)), false);
  assert.equal(validFrontmatterCache(next.used), true);
  assert.equal(
    validFrontmatterCache(new Map([[contentEtag(prefix), { data: { x: 1 }, keys: [] }]])),
    false,
  );
  assert.equal(
    validFrontmatterCache(new Map([[contentEtag(prefix), { data: { x: Infinity }, keys: ["x"] }]])),
    false,
  );
});

test("parallel cache scopes keep their own observed headers", async () => {
  const [a, b] = await Promise.all(
    ["a", "b"].map((key) =>
      withFrontmatterCache(new Map(), async () => {
        await Promise.resolve();
        return parseFrontmatter(`---\n${key}: true\n---\n`);
      }),
    ),
  );
  assert.equal(a.used.size, 1);
  assert.equal(b.used.size, 1);
  assert.deepEqual(a.result.data, { a: true });
  assert.deepEqual(b.result.data, { b: true });
});

test("disk cache is disposable, preserves values, prunes unused headers and tolerates blocked writes", async (t) => {
  const root = await fixture(t);
  const directory = path.join(root, ".git", "tent-material-cache");
  const file = path.join(directory, "document-headers.bin");
  await fs.mkdir(path.join(root, ".git"));
  const read = () => withDocumentHeaderCache(root, async () => parseFrontmatter(prefix + "body"));
  const cold = await read();
  const bytes = await fs.readFile(file);
  const before = await fs.stat(file);
  const warm = await read();
  assert.deepEqual(warm, cold);
  assert.equal(warm.data.base, warm.data.copy);
  assert.ok(Object.is((warm.data.base as { n: number }).n, -0));
  assert.equal(serializeFrontmatter(warm.data, warm.body, warm.keyOrder), prefix + "body");
  assert.deepEqual(await fs.readFile(file), bytes);
  assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
  await fs.writeFile(file, "corrupt");
  assert.deepEqual(await read(), cold);
  await fs.rm(file);
  assert.deepEqual(await read(), cold);
  await withDocumentHeaderCache(root, async () => parseFrontmatter("---\nonly: true\n---\n"));
  assert.ok((await fs.stat(file)).size < bytes.length);
  // A directory at the cache filename blocks replacement on every supported OS.
  await fs.rm(file);
  await fs.mkdir(file);
  assert.deepEqual(await read(), cold);
  assert.deepEqual(await fs.readdir(directory), ["document-headers.bin"]);
  await assert.rejects(
    withDocumentHeaderCache(root, async () => {
      throw new Error("action failed");
    }),
    /action failed/,
  );
  assert.deepEqual(await fs.readdir(directory), ["document-headers.bin"]);
});

test("without Tent Git the scope performs no cache writes", async (t) => {
  const root = await fixture(t);
  await withDocumentHeaderCache(root, async () => parseFrontmatter(prefix));
  assert.deepEqual(await fs.readdir(root), []);
});

test("warm brief observes same-size native edits and bad headers without changing authority on a hit", async (t) => {
  const root = await fixture(t);
  await scaffoldInWorkspace(new NodeFs(root), {
    name: "Cache",
    nodes: [{ id: "node-cachetest", name: "Fact", type: "prompt", body: "old body" }],
  });
  const system = path.join(root, ".tent");
  await git(system, "init");
  await git(system, "add", ".");
  await git(system, "commit", "-m", "fixture");
  const file = path.join(system, "Fact", "Fact.md");
  const cache = path.join(system, ".git", "tent-material-cache", "document-headers.bin");
  const brief = async () => {
    const result = await runWorkspaceCommand("brief", ["--json"], { workspace: root });
    assert.equal(result.exitCode, 0, result.stderr);
    return result.stdout;
  };
  const first = await brief();
  const head = await git(system, "rev-parse", "HEAD");
  const raw = await fs.readFile(file, "utf8");
  assert.equal(await brief(), first);
  assert.equal(await git(system, "rev-parse", "HEAD"), head);
  assert.equal(await fs.readFile(file, "utf8"), raw);
  const stat = await fs.stat(file);
  const edited = raw.replace("prompt", "output").replace("old body", "new body");
  assert.equal(edited.length, raw.length);
  await fs.writeFile(file, edited);
  await fs.utimes(file, stat.atime, stat.mtime);
  const after = await brief();
  assert.notEqual(after, first);
  assert.equal(JSON.parse(after).roots[0].type, "output");
  assert.equal(await fs.readFile(file, "utf8"), edited);
  assert.notEqual(await git(system, "rev-parse", "HEAD"), head);
  await fs.rm(cache);
  assert.equal(await brief(), after);
  const retained = await git(system, "rev-parse", "HEAD");
  await fs.writeFile(file, edited.replace("type: output", "type: [bad"));
  const invalid = JSON.parse(await brief());
  assert.equal(invalid.invalidNodes.length, 1);
  assert.match(invalid.invalidNodes[0].reason, /YAML/);
  assert.equal(await git(system, "rev-parse", "HEAD"), retained);
});
