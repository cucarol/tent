import { openTestFs, removeTestFixture } from "./node-fs.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { NodeFs } from "../src/fs/node-fs.js";
import { withFileReadScope } from "../src/fs/file-state-cache.js";
import { readStructureSource } from "../src/fs/source-observation.js";
import { testScratchRoot } from "./scratch.js";

const raw = (id = "node-first") =>
  `---\nid: ${id}\ntype: prompt\n---\n${"Body 😀\n".repeat(10_000)}`;

async function age(filename: string) {
  const old = new Date(Date.now() - 5_000);
  await fs.utimes(filename, old, old);
}

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "file-state-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
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
    adapter: openTestFs(systemRoot),
  };
}

/** Count actual bytes read from the source files, excluding all cache and Git I/O. */
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
  const openMock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
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
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
  const readFile = fs.readFile;
  const readMock = t.mock.method(fs, "readFile", async (...args: Parameters<typeof readFile>) => {
    const result = await readFile(...args);
    if (wanted.has(path.resolve(String(args[0])))) {
      counts.opens++;
      counts.reads++;
      counts.bytes += Buffer.byteLength(result);
    }
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => {
    openMock.mock.restore();
    readMock.mock.restore();
    syncBuiltinESMExports();
  });
  return counts;
}

async function readCached(adapter: NodeFs, relative: string) {
  return withFileReadScope(async () => ({
    header: await adapter.readFrontmatter(relative),
  }));
}

test("header caches persist across requests without reading unchanged source bytes", async (t) => {
  const f = await fixture(t);
  const io = sourceIo(t, [f.filename]);
  const cold = await readCached(f.adapter, f.relative);
  assert.match(cold.header, /node-first/);
  assert.ok(io.bytes > 0 && io.bytes < Buffer.byteLength(raw()));
  io.reset();
  const warm = await readCached(openTestFs(f.systemRoot), f.relative);
  assert.equal(warm.header, cold.header);
  assert.equal(io.bytes, 0);
  assert.equal(io.reads, 0);
  assert.equal(io.opens, 0);
});

test("same-size native edits with restored mtime invalidate header caches through ctime", async (t) => {
  const f = await fixture(t);
  await readCached(f.adapter, f.relative);
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
  const observed = await readCached(f.adapter, f.relative);
  assert.match(observed.header, /id: node-other/);
  assert.ok(io.bytes > 0 && io.bytes < Buffer.byteLength(changed));
});

test("racy files are read again even when their recorded file state still matches", async (t) => {
  const f = await fixture(t);
  const now = new Date();
  await fs.utimes(f.filename, now, now);
  const io = sourceIo(t, [f.filename]);
  await readCached(f.adapter, f.relative);
  io.reset();
  await readCached(f.adapter, f.relative);
  assert.ok(io.bytes > 0 && io.bytes < Buffer.byteLength(raw()));
});

test("structure text reads fresh bytes across requests and observes native edits", async (t) => {
  const f = await fixture(t);
  const io = sourceIo(t, [f.filename]);
  const read = () => readStructureSource(f.filename);
  assert.equal(await read(), raw());
  assert.equal(io.bytes, Buffer.byteLength(raw()));
  io.reset();
  assert.equal(await read(), raw());
  assert.equal(io.bytes, Buffer.byteLength(raw()));
  const oldTimes = await fs.stat(f.filename);
  const changed = raw("node-other");
  await fs.writeFile(f.filename, changed);
  await fs.utimes(f.filename, oldTimes.atime, oldTimes.mtime);
  assert.equal(await read(), changed);
});

test("structure text rejects invalid UTF-8 and NUL bytes", async (t) => {
  const f = await fixture(t);
  for (const invalid of [Buffer.from([0xff]), Buffer.from("source\0text")]) {
    await fs.writeFile(f.filename, invalid);
    await assert.rejects(
      readStructureSource(f.filename),
      /encoded data was not valid|encoding|UTF-8|not valid text/i,
    );
  }
});

test("deleted, corrupt and obsolete persisted caches fall back to source bytes", async (t) => {
  const f = await fixture(t);
  const expected = await readCached(f.adapter, f.relative);
  const valid = await fs.readFile(f.cacheFile, "utf8");
  const io = sourceIo(t, [f.filename]);
  const variants = [
    undefined,
    "broken JSON",
    JSON.stringify({ ...JSON.parse(valid), schema: 999 }),
  ];
  for (const invalid of variants) {
    if (invalid === undefined) await fs.rm(f.cacheFile);
    else await fs.writeFile(f.cacheFile, invalid);
    io.reset();
    const actual = await readCached(f.adapter, f.relative);
    assert.equal(actual.header, expected.header);
    assert.ok(io.bytes > 0 && io.bytes < Buffer.byteLength(raw()));
  }
});

test("one request reads a file's bytes once across text, binary and header reads", async (t) => {
  const f = await fixture(t);
  const io = sourceIo(t, [f.filename]);
  await withFileReadScope(async () => {
    assert.equal(await f.adapter.readFile(f.relative), raw());
    assert.equal(io.bytes, Buffer.byteLength(raw()));
    assert.equal(Buffer.from(await f.adapter.readBinary(f.relative)).toString("utf8"), raw());
    assert.match(await f.adapter.readFrontmatter(f.relative), /id: node-first/);
    assert.equal(io.bytes, Buffer.byteLength(raw()));
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
  assert.deepEqual(await first, [raw(), raw()]);
});

test("concurrent readers in one request acquire source bytes once", async (t) => {
  const f = await fixture(t);
  const io = sourceIo(t, [f.filename]);
  const [text, binary] = await withFileReadScope(() =>
    Promise.all([f.adapter.readFile(f.relative), f.adapter.readBinary(f.relative)]),
  );
  assert.equal(text, raw());
  assert.equal(Buffer.from(binary).toString("utf8"), raw());
  assert.equal(io.bytes, Buffer.byteLength(raw()));
});

test("one request keeps the bytes it read; the next request sees a native edit", async (t) => {
  const f = await fixture(t);
  const changed = raw("node-other");
  await withFileReadScope(async () => {
    assert.equal(await f.adapter.readFile(f.relative), raw());
    await fs.writeFile(f.filename, changed);
    assert.equal(await f.adapter.readFile(f.relative), raw());
  });
  assert.equal(await f.adapter.readFile(f.relative), changed);
});
