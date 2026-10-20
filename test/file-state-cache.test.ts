import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { NodeFs } from "../src/fs/node-fs.js";
import { withFileReadScope } from "../src/fs/file-state-cache.js";
import { observeSourceFile, readStructureSource } from "../src/fs/source-observation.js";
import { inspectNodeSync } from "../src/core/graph/node-sync.js";
import { testScratchRoot } from "./scratch.js";
import { git } from "./helpers.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const raw = (id = "node-first") =>
  `---\nid: ${id}\ntype: prompt\n---\n${"Body 😀\n".repeat(10_000)}`;

async function age(filename: string) {
  const old = new Date(Date.now() - 5_000);
  await fs.utimes(filename, old, old);
}

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "file-state-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  const systemRoot = path.join(root, ".tent");
  await fs.mkdir(path.join(systemRoot, ".git"), { recursive: true });
  await fs.mkdir(path.join(systemRoot, "A"));
  await fs.writeFile(path.join(systemRoot, "index.md"), '---\nokf_version: "0.2"\n---\n');
  const relative = "A/A.md",
    filename = path.join(systemRoot, relative);
  await fs.writeFile(filename, raw());
  await age(filename);
  const cacheDir = path.join(systemRoot, ".git", "tent-material-cache");
  return {
    root,
    systemRoot,
    relative,
    filename,
    cacheDir,
    cacheFile: path.join(cacheDir, "file-state.json"),
    adapter: new NodeFs(systemRoot),
  };
}

/** Count actual bytes returned by source handles, excluding all cache and Git I/O. */
function sourceIo(t: TestContext, filenames: string[]) {
  const wanted = new Set(filenames.map((filename) => path.resolve(filename)));
  const counts = {
    bytes: 0,
    reads: 0,
    opens: 0,
    reset() {
      this.bytes = 0;
      this.reads = 0;
      this.opens = 0;
    },
  };
  const open = fs.open;
  const mocked = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (!wanted.has(path.resolve(String(args[0])))) return handle;
    counts.opens++;
    return new Proxy(handle, {
      get(target, key) {
        if (key === "read")
          return async (...readArgs: unknown[]) => {
            const result = await Reflect.apply(target.read, target, readArgs);
            counts.reads++;
            counts.bytes += result.bytesRead;
            return result;
          };
        if (key === "readFile")
          return async (...readArgs: unknown[]) => {
            const result = await Reflect.apply(target.readFile, target, readArgs);
            counts.reads++;
            counts.bytes += Buffer.byteLength(result);
            return result;
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  return counts;
}

async function readCached(
  adapter: NodeFs,
  relative: string,
  root: string,
  filename: string,
  cacheDir: string,
) {
  return withFileReadScope(async () => ({
    header: await adapter.readFrontmatter(relative),
    digest: await adapter.readContentDigest(relative),
    material: await observeSourceFile(root, filename, cacheDir),
  }));
}

test("header, digest and material caches persist across requests without reading unchanged source bytes", async (t) => {
  const f = await fixture(t);
  const io = sourceIo(t, [f.filename]);
  const cold = await readCached(f.adapter, f.relative, f.systemRoot, f.filename, f.cacheDir);
  assert.equal(cold.digest.digest, digest(raw()));
  assert.equal(cold.material.observedVersion, digest(raw()));
  assert.equal(
    io.bytes,
    Buffer.byteLength(raw()),
    "prefix and remainder must acquire each byte once",
  );
  io.reset();
  const warm = await readCached(
    new NodeFs(f.systemRoot),
    f.relative,
    f.systemRoot,
    f.filename,
    f.cacheDir,
  );
  assert.equal(warm.header, cold.header);
  assert.deepEqual(warm.digest, cold.digest);
  assert.equal(warm.material.observedVersion, cold.material.observedVersion);
  assert.equal(warm.material.cacheHit, true);
  assert.equal(io.bytes, 0);
  assert.equal(io.reads, 0);
  assert.equal(io.opens, 0);
});

test("same-size native edits with restored mtime invalidate header, digest and material caches through ctime", async (t) => {
  const f = await fixture(t);
  await readCached(f.adapter, f.relative, f.systemRoot, f.filename, f.cacheDir);
  const before = await fs.stat(f.filename, { bigint: true });
  const oldTimes = await fs.stat(f.filename);
  const changed = raw("node-other");
  assert.equal(Buffer.byteLength(changed), Buffer.byteLength(raw()));
  await fs.writeFile(f.filename, changed);
  await fs.utimes(f.filename, oldTimes.atime, oldTimes.mtime);
  const after = await fs.stat(f.filename, { bigint: true });
  assert.equal(after.size, before.size);
  assert.equal(
    after.mtimeNs,
    before.mtimeNs,
    "fixture must restore the exact modification timestamp",
  );
  assert.notEqual(after.ctimeNs, before.ctimeNs, "fixture must change ctime");
  const io = sourceIo(t, [f.filename]);
  const observed = await readCached(f.adapter, f.relative, f.systemRoot, f.filename, f.cacheDir);
  assert.match(observed.header, /id: node-other/);
  assert.equal(observed.digest.digest, digest(changed));
  assert.equal(observed.material.observedVersion, digest(changed));
  assert.equal(observed.material.cacheHit, false);
  assert.equal(io.bytes, Buffer.byteLength(changed));
});

test("racy files are read again even when their recorded file state still matches", async (t) => {
  const f = await fixture(t);
  const now = new Date();
  await fs.utimes(f.filename, now, now);
  const io = sourceIo(t, [f.filename]);
  await readCached(f.adapter, f.relative, f.systemRoot, f.filename, f.cacheDir);
  io.reset();
  const observed = await readCached(f.adapter, f.relative, f.systemRoot, f.filename, f.cacheDir);
  assert.equal(observed.digest.digest, digest(raw()));
  assert.equal(observed.material.cacheHit, false);
  assert.equal(io.bytes, Buffer.byteLength(raw()));
});

test("structure text survives a fresh read scope, invalidates on native edits and bypasses cache for checks", async (t) => {
  const f = await fixture(t);
  const io = sourceIo(t, [f.filename]);
  const read = () => readStructureSource(f.root, f.filename, f.cacheDir);
  assert.equal(await read(), raw());
  assert.equal(io.bytes, Buffer.byteLength(raw()));
  io.reset();
  assert.equal(await read(), raw());
  assert.equal(io.opens, 0, "a warm structure parser must receive text without reopening sources");
  assert.equal(await withFileReadScope(read, true), raw());
  assert.equal(io.bytes, Buffer.byteLength(raw()), "explicit checks must still acquire bytes");
  const oldTimes = await fs.stat(f.filename);
  const changed = raw("node-other");
  await fs.writeFile(f.filename, changed);
  await fs.utimes(f.filename, oldTimes.atime, oldTimes.mtime);
  io.reset();
  assert.equal(await read(), changed);
  assert.equal(io.bytes, Buffer.byteLength(changed));
  await fs.utimes(f.filename, new Date(), new Date());
  await read();
  io.reset();
  assert.equal(await read(), changed);
  assert.equal(io.bytes, Buffer.byteLength(changed), "racy text must not become a cache hit");
});

test("invalid or missing cached structure text falls back to validated source bytes", async (t) => {
  const f = await fixture(t);
  const read = () => readStructureSource(f.root, f.filename, f.cacheDir);
  await read();
  const valid = await fs.readFile(f.cacheFile, "utf8");
  const io = sourceIo(t, [f.filename]);
  for (const mode of ["missing", "damaged", "json", "deleted"]) {
    const parsed = JSON.parse(valid);
    const entry = Object.values(parsed.entries)[0] as { value: { text?: string } };
    if (mode === "missing") delete entry.value.text;
    if (mode === "damaged") entry.value.text = "incorrect source";
    if (mode === "deleted") await fs.rm(f.cacheFile);
    else await fs.writeFile(f.cacheFile, mode === "json" ? "broken" : JSON.stringify(parsed));
    io.reset();
    assert.equal(await read(), raw());
    assert.equal(io.bytes, Buffer.byteLength(raw()));
  }
  for (const invalid of [Buffer.from([0xff]), Buffer.from("source\0text")]) {
    await fs.writeFile(f.filename, invalid);
    await assert.rejects(read(), /encoded data was not valid|encoding|UTF-8|not valid text/i);
  }
});

test("deleted, corrupt, obsolete and tampered persisted entries fall back to source bytes", async (t) => {
  const f = await fixture(t);
  const expected = await readCached(f.adapter, f.relative, f.systemRoot, f.filename, f.cacheDir);
  const valid = await fs.readFile(f.cacheFile, "utf8");
  const io = sourceIo(t, [f.filename]);
  const variants = [
    undefined,
    "broken JSON",
    JSON.stringify({ ...JSON.parse(valid), schema: 999 }),
    (() => {
      const cache = JSON.parse(valid);
      cache.schema = 1;
      const entry = cache.entries[`header:${f.filename}`];
      entry.value = "---\nid: node-replaced\ntype: output\n---\n";
      entry.digest = digest(JSON.stringify([entry.state, entry.writtenAtNs, entry.value]));
      return JSON.stringify(cache);
    })(),
    (() => {
      const cache = JSON.parse(valid);
      for (const entry of Object.values(cache.entries) as Array<{ digest: string }>)
        entry.digest = "broken";
      return JSON.stringify(cache);
    })(),
    JSON.stringify({ schema: 2, entries: [] }),
  ];
  for (const invalid of variants) {
    if (invalid === undefined) await fs.rm(f.cacheFile);
    else await fs.writeFile(f.cacheFile, invalid);
    io.reset();
    const actual = await readCached(f.adapter, f.relative, f.systemRoot, f.filename, f.cacheDir);
    assert.equal(actual.header, expected.header);
    assert.deepEqual(actual.digest, expected.digest);
    assert.equal(actual.material.observedVersion, expected.material.observedVersion);
    assert.equal(actual.material.cacheHit, false);
    assert.equal(io.bytes, Buffer.byteLength(raw()));
  }
});

test("one request shares prefix and remaining bytes across text, binary, digest and material reads", async (t) => {
  const f = await fixture(t);
  const io = sourceIo(t, [f.filename]);
  await withFileReadScope(async () => {
    assert.match(await f.adapter.readFrontmatter(f.relative), /id: node-first/);
    assert.ok(io.bytes > 0 && io.bytes < Buffer.byteLength(raw()));
    assert.equal(await f.adapter.readFile(f.relative), raw());
    const acquired = io.bytes;
    assert.equal(acquired, Buffer.byteLength(raw()));
    assert.equal(Buffer.from(await f.adapter.readBinary(f.relative)).toString("utf8"), raw());
    assert.equal((await f.adapter.readContentDigest(f.relative)).digest, digest(raw()));
    assert.equal(
      (await observeSourceFile(f.systemRoot, f.filename, f.cacheDir)).observedVersion,
      digest(raw()),
    );
    assert.equal(
      io.bytes,
      acquired,
      "later APIs must reuse the bytes already acquired by this request",
    );
  });
});

test("overlapping independent scopes observe separate native file versions", async (t) => {
  const f = await fixture(t);
  let ready!: () => void, resume!: () => void;
  const acquired = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const released = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const first = withFileReadScope(async () => {
    const before = await f.adapter.readFile(f.relative);
    ready();
    await released;
    return [before, await f.adapter.readFile(f.relative)];
  });
  await acquired;
  const changed = raw("node-other");
  await fs.writeFile(f.filename, changed);
  try {
    const second = await withFileReadScope(() => f.adapter.readFile(f.relative));
    assert.equal(second, changed);
  } finally {
    resume();
  }
  assert.deepEqual(await first, [raw(), changed]);
});

test("forced scopes bypass persisted values and a parent request's acquired bytes", async (t) => {
  const f = await fixture(t);
  const expected = await readCached(f.adapter, f.relative, f.systemRoot, f.filename, f.cacheDir);
  const io = sourceIo(t, [f.filename]);
  await withFileReadScope(async () => {
    assert.equal(await f.adapter.readFrontmatter(f.relative), expected.header);
    assert.equal((await f.adapter.readContentDigest(f.relative)).digest, expected.digest.digest);
  }, true);
  assert.equal(io.bytes, Buffer.byteLength(raw()));
  await withFileReadScope(async () => {
    assert.equal(await f.adapter.readFile(f.relative), raw());
    const changed = raw("node-other");
    await fs.writeFile(f.filename, changed);
    const forced = await withFileReadScope(() => f.adapter.readFile(f.relative), true);
    assert.equal(forced, changed);
  });
});

test("single Node sync inspection rechecks material bytes despite a stable persisted fingerprint", async (t) => {
  const f = await fixture(t);
  await git(f.systemRoot, "init", "--quiet");
  const source = path.join(f.root, "source.txt"),
    sourceText = "Material contents\n";
  await fs.writeFile(source, sourceText);
  await age(source);
  await fs.writeFile(
    f.filename,
    "---\nid: node-first\ntype: prompt\nsources:\n  - resource: ../../source.txt\n---\nNode\n",
  );
  await age(f.filename);
  const initial = await inspectNodeSync(f.adapter, "node-first");
  assert.equal(initial.materials[0]?.currentVersion, digest(sourceText));
  const warm = await f.adapter.observeMaterial("../../source.txt", f.relative);
  assert.equal(warm.cacheHit, true);
  const io = sourceIo(t, [source]);
  const checked = await inspectNodeSync(f.adapter, "node-first");
  assert.equal(checked.materials[0]?.currentVersion, digest(sourceText));
  assert.equal(io.bytes, Buffer.byteLength(sourceText));
});

test("concurrent readers in one request acquire source bytes once across header, text, binary and material APIs", async (t) => {
  const f = await fixture(t);
  const io = sourceIo(t, [f.filename]);
  const [header, text, binary, observed, fingerprint] = await withFileReadScope(() =>
    Promise.all([
      f.adapter.readFrontmatter(f.relative),
      f.adapter.readFile(f.relative),
      f.adapter.readBinary(f.relative),
      observeSourceFile(f.systemRoot, f.filename, f.cacheDir),
      f.adapter.readContentDigest(f.relative),
    ]),
  );
  assert.match(header, /id: node-first/);
  assert.equal(text, raw());
  assert.equal(Buffer.from(binary).toString("utf8"), raw());
  assert.equal(observed.observedVersion, digest(raw()));
  assert.equal(fingerprint.digest, digest(raw()));
  assert.equal(io.bytes, Buffer.byteLength(raw()));
});

test("a later read in one request revalidates acquired bytes after a native edit", async (t) => {
  const f = await fixture(t);
  const changed = raw("node-other");
  const io = sourceIo(t, [f.filename]);
  await withFileReadScope(async () => {
    assert.equal(await f.adapter.readFile(f.relative), raw());
    await fs.writeFile(f.filename, changed);
    assert.equal(await f.adapter.readFile(f.relative), changed);
  });
  assert.equal(io.bytes, Buffer.byteLength(raw()) + Buffer.byteLength(changed));
});

test("Node sync retries a native Node body edit made during material observation", async (t) => {
  const f = await fixture(t);
  await git(f.systemRoot, "init", "--quiet");
  const source = path.join(f.root, "source.txt");
  await fs.writeFile(source, "Material contents\n");
  const before =
    "---\nid: node-first\ntype: prompt\nsources:\n  - resource: ../../source.txt\n---\nOriginal body\n";
  const changed = before.replace("Original body", "Native changed body");
  await fs.writeFile(f.filename, before);
  const nodeReads: string[] = [];
  const readFile = f.adapter.readFile.bind(f.adapter);
  t.mock.method(f.adapter, "readFile", async (filename: string) => {
    const content = await readFile(filename);
    if (filename === f.relative) nodeReads.push(content);
    return content;
  });
  let observations = 0;
  const observe = f.adapter.observeMaterial.bind(f.adapter);
  t.mock.method(f.adapter, "observeMaterial", async (...args: Parameters<typeof observe>) => {
    const observed = await observe(...args);
    observations++;
    if (observations === 1) {
      assert.ok(
        nodeReads.includes(before),
        "the edit must happen after the initial Node bytes were acquired",
      );
      await fs.writeFile(f.filename, changed);
    }
    return observed;
  });
  const inspection = await inspectNodeSync(f.adapter, "node-first");
  assert.ok(
    nodeReads.includes(changed),
    "the final source boundary must observe the new Node body",
  );
  assert.ok(
    observations > 1 || inspection.uncertain,
    "the Node edit must trigger a material retry or an explicitly uncertain result",
  );
  assert.equal(await fs.readFile(f.filename, "utf8"), changed);
});
