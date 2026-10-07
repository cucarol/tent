import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { createNode, renameNode, moveNode } from "../src/core/ops.js";
import { nodeNotePath } from "../src/core/tree.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { readNodeForEdit } from "../src/core/node-query.js";
import {
  writeNodeDocument,
  NodeWriteError,
  type NodeDocumentEdit,
} from "../src/core/node-document-write.js";

async function fixture(t: TestContext) {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "core-node-cas-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await scaffoldInWorkspace(new NodeFs(root), { name: "CAS" });
  const adapter = new NodeFs(path.join(root, ".tent")),
    peer = new NodeFs(path.join(root, ".tent"));
  const env = { fs: adapter, clock: { now: () => new Date().toISOString() }, tentName: "CAS" };
  const create = (name: string, body = "") =>
    createNode(env, { parentPath: "", name, type: "prompt", body });
  return { adapter, peer, env, create };
}

test("unchanged Core saves preserve bytes; changed saves return their written bytes without rereading", async (t) => {
  const { adapter, create } = await fixture(t);
  const id = await create("Same", "Existing fact"),
    current = await readNodeForEdit(adapter, id),
    note = nodeNotePath(current.path);
  const read = adapter.readFile.bind(adapter),
    write = adapter.writeFile.bind(adapter);
  let writes = 0,
    readsAfterWrite = 0;
  adapter.writeFile = async (file, raw) => {
    if (file === note) writes++;
    await write(file, raw);
  };
  adapter.readFile = async (file) => {
    if (file === note && writes) readsAfterWrite++;
    return read(file);
  };
  for (const content of [{ raw: current.raw }, { body: current.body }]) {
    const saved = await writeNodeDocument(adapter, id, { baseEtag: current.etag, ...content });
    assert.equal(saved.etag, current.etag);
    assert.equal(saved.raw, current.raw);
    assert.equal(saved.changed, false);
    assert.equal(writes, 0);
  }
  await assert.rejects(
    writeNodeDocument(adapter, id, { baseEtag: "stale", raw: current.raw }),
    /etag conflict/,
  );
  const saved = await writeNodeDocument(adapter, id, {
    baseEtag: current.etag,
    body: "Updated fact",
  });
  assert.notEqual(saved.etag, current.etag);
  assert.match(saved.raw, /Updated fact/);
  assert.equal(saved.changed, true);
  assert.equal(writes, 1);
  assert.equal(readsAfterWrite, 0);
});

test("Core write lookup races remain conflicts while storage EIO retains its identity", async (t) => {
  const { adapter, create } = await fixture(t),
    id = await create("Race", "keep");
  const original = await readNodeForEdit(adapter, id),
    note = nodeNotePath(original.path);
  const header = adapter.readFrontmatter.bind(adapter),
    read = adapter.readFile.bind(adapter),
    write = adapter.writeFile.bind(adapter);
  for (const scenario of ["valid", "invalid", "io"] as const) {
    await write(note, original.raw);
    let observed = false,
      writes = 0;
    const external = original.raw.replace(
      "type: prompt",
      scenario === "valid" ? "type: output" : "type: [broken",
    );
    adapter.readFrontmatter = async (file) => {
      const result = await header(file);
      if (file === note) {
        observed = true;
        if (scenario !== "io") await write(file, external);
      }
      return result;
    };
    adapter.readFile = async (file) => {
      if (file === note && observed && scenario === "io")
        throw Object.assign(new Error("test EIO"), { code: "EIO" });
      return read(file);
    };
    adapter.writeFile = async (file, raw) => {
      writes++;
      await write(file, raw);
    };
    await assert.rejects(
      writeNodeDocument(adapter, id, { baseEtag: original.etag, body: "draft" }),
      (error) => {
        if (scenario === "io") {
          assert.equal((error as NodeJS.ErrnoException).code, "EIO");
          assert.equal(error instanceof NodeWriteError, false);
        } else {
          assert.ok(error instanceof NodeWriteError);
          assert.equal(error.code, "ETAG_CONFLICT");
          assert.equal(error.details?.currentEtag, undefined);
        }
        return true;
      },
    );
    assert.equal(writes, 0);
    assert.equal(await read(note), scenario === "io" ? original.raw : external);
    adapter.readFile = read;
    adapter.readFrontmatter = header;
    adapter.writeFile = write;
  }
});

test("Core content, metadata and structural no-ops retain exact bytes and do not recreate order", async (t) => {
  const { adapter, create, env } = await fixture(t),
    id = await create("Same");
  const raw = `---\ntype: prompt # keep ordering and comment\nid: ${id}\npath: 'C:\\workspace\\file.txt'\n---\nFact`;
  await adapter.writeFile("Same/Same.md", raw);
  await adapter.remove("order.json");
  const current = await readNodeForEdit(adapter, id);
  const write = adapter.writeFile.bind(adapter);
  let writes = 0;
  adapter.writeFile = async (file, value) => {
    writes++;
    await write(file, value);
  };
  for (const input of [{ raw }, { body: current.body }, { frontmatter: { type: "prompt" } }])
    await writeNodeDocument(adapter, id, { baseEtag: current.etag, ...input });
  await renameNode(env, id, "Same");
  await moveNode(env, id, null, { mode: "inside" }, current.path);
  assert.equal(await adapter.readFile("Same/Same.md"), raw);
  assert.equal(await adapter.exists("order.json"), false);
  assert.equal(writes, 0);
});

test("Core write preserves an EIO from the post-normalization read without writing", async (t) => {
  const { adapter, create } = await fixture(t);
  const id = await create("Race", "original"),
    peerId = await create("Peer");
  const original = await readNodeForEdit(adapter, id),
    note = nodeNotePath(original.path);
  const read = adapter.readFile.bind(adapter),
    header = adapter.readFrontmatter.bind(adapter);
  const failure = Object.assign(new Error("late storage failure"), { code: "EIO" });
  let peerReads = 0,
    resolved = false;
  adapter.readFrontmatter = async (file) => {
    const value = await header(file);
    if (file === "Peer/Peer.md" && ++peerReads === 2) resolved = true;
    return value;
  };
  adapter.readFile = async (file) => {
    if (file === note && resolved) throw failure;
    return read(file);
  };
  await assert.rejects(
    writeNodeDocument(adapter, id, { baseEtag: original.etag, body: `[peer](${peerId})` }),
    (error) => error === failure,
  );
  assert.equal(await read(note), original.raw);
});

test("independent adapters enforce the Workspace lock and stale CAS for every Node edit form", async (t) => {
  const { adapter, peer, create } = await fixture(t);
  for (const mode of [
    "body",
    "raw",
    "frontmatter",
    "type",
    "tags",
    "tag-add",
    "tag-remove",
  ] as const) {
    const id = await create(mode, "base"),
      firstRead = await readNodeForEdit(adapter, id);
    if (mode === "tag-remove")
      await writeNodeDocument(adapter, id, {
        baseEtag: firstRead.etag,
        frontmatter: { tags: ["author-a", "author-b"] },
      });
    const live = await readNodeForEdit(adapter, id),
      originalRead = adapter.readFile.bind(adapter);
    let reached!: () => void,
      release!: () => void,
      paused = false;
    const reading = new Promise<void>((resolve) => (reached = resolve)),
      proceed = new Promise<void>((resolve) => (release = resolve));
    adapter.readFile = async (file) => {
      const raw = await originalRead(file);
      if (!paused && file === nodeNotePath(live.path)) {
        paused = true;
        reached();
        await proceed;
      }
      return raw;
    };
    const payload = (author: "a" | "b"): NodeDocumentEdit =>
      mode === "body"
        ? { body: author }
        : mode === "raw"
          ? { raw: serializeFrontmatter(live.frontmatter, author) }
          : {
              frontmatter:
                mode === "type"
                  ? { type: author === "a" ? "output" : "goal" }
                  : ["tags", "tag-add", "tag-remove"].includes(mode)
                    ? {
                        tags: [
                          `author-${mode === "tag-remove" ? (author === "a" ? "b" : "a") : author}`,
                        ],
                      }
                    : { reviewer: author },
            };
    const send = (fs: NodeFs, author: "a" | "b") =>
      writeNodeDocument(fs, id, { baseEtag: live.etag, ...payload(author) });
    const first = send(adapter, "a");
    let settled = false;
    let second: Promise<void> | undefined;
    try {
      await reading;
      second = assert.rejects(send(peer, "b"), /etag conflict/).finally(() => {
        settled = true;
      });
      await delay(100);
      assert.equal(settled, false, "the second writer waits before checking its stale CAS basis");
    } finally {
      release();
      await first;
      adapter.readFile = originalRead;
    }
    await second;
    await assert.rejects(send(peer, "b"), /etag conflict/);
    const after = await readNodeForEdit(adapter, id);
    if (mode === "type") assert.equal(after.type, "output");
    else if (["tags", "tag-add", "tag-remove"].includes(mode))
      assert.deepEqual(after.frontmatter.tags, [mode === "tag-remove" ? "author-b" : "author-a"]);
    else assert.equal(mode === "frontmatter" ? after.frontmatter.reviewer : after.body, "a");
  }
});

test("former reserved names are ordinary metadata while Node identity stays fixed", async (t) => {
  const { adapter, create } = await fixture(t),
    id = await create("Reference", "Keep body");
  let live = await readNodeForEdit(adapter, id);
  const metadata = {
    artifactRefs: [{ kind: "commit", target: "abc123" }],
    owner: "someone",
    mode: "custom",
  };
  await writeNodeDocument(adapter, id, { baseEtag: live.etag, frontmatter: metadata });
  live = await readNodeForEdit(adapter, id);
  assert.deepEqual(
    Object.fromEntries(Object.keys(metadata).map((key) => [key, live.frontmatter[key]])),
    metadata,
  );
  const parsed = parseFrontmatter(live.raw);
  await writeNodeDocument(adapter, id, {
    baseEtag: live.etag,
    raw: serializeFrontmatter({ ...parsed.data, relations: ["related"] }, parsed.body),
  });
  live = await readNodeForEdit(adapter, id);
  assert.deepEqual(live.frontmatter.relations, ["related"]);
  await assert.rejects(
    writeNodeDocument(adapter, id, { baseEtag: live.etag, frontmatter: { id: "node-other" } }),
    /Node id/,
  );
  assert.equal((await readNodeForEdit(adapter, id)).raw, live.raw);
});
