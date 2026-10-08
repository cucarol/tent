import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { GitDocumentHistory } from "../src/core/git-history.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { exportGraph } from "../src/fs/graph-export.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { createNode, renameNode } from "../src/core/ops.js";
import { readNodeForEdit } from "../src/core/node-query.js";
import { writeNodeDocument } from "../src/core/node-document-write.js";
import { writeNodesBatch } from "../src/core/node-write-batch.js";
import { confirmNodeSync, inspectNodeSync } from "../src/core/node-sync.js";
import { git } from "./helpers.js";
import { testScratchRoot } from "./scratch.js";

async function fixture(t: TestContext) {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "node-record-version-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  await scaffoldInWorkspace(new NodeFs(workspace), { name: "Record versions" });
  const system = path.join(workspace, ".tent");
  const adapter = new NodeFs(system);
  await git(system, "init", "--initial-branch=main");
  const settings = JSON.parse(await adapter.readFile("settings.json")) as { workspaceId: string };
  const env = {
    fs: adapter,
    clock: { now: () => "2026-10-05T00:00:00.000Z" },
    tentName: "Record versions",
  };
  const mount = {
    workspaceRoot: workspace,
    systemRoot: system,
    workspaceId: settings.workspaceId,
    env,
  };
  async function commitTrailers(lines: string[]) {
    await git(
      system,
      "commit",
      "--allow-empty",
      "-m",
      ["test: record declarations", "", ...lines].join("\n"),
    );
    return (await git(system, "rev-parse", "HEAD")).trim();
  }
  return { workspace, system, adapter, env, mount, commitTrailers };
}

const trailer = (id: string, record: unknown) =>
  `Tent-Node-Record: ${JSON.stringify([id, record])}`;

test("same-HEAD version 1 derived caches cannot restore an unversioned Node baseline", async (t) => {
  const { system, adapter, commitTrailers } = await fixture(t);
  const valid = { v: 1 as const, materials: [], extension: "current" };
  await adapter.history.captureUnlocked([], {
    operation: "test.record.cache-bases",
    nodeRecords: { "node-invalidated": valid, "node-unaffected": valid },
  });
  const head = await commitTrailers([trailer("node-invalidated", { materials: [] })]);
  const value = {
    "node-invalidated": { materials: [{ identity: "stale", version: "a".repeat(64) }] },
    "node-unaffected": { materials: [], extension: "old cached value" },
  };
  const filename = path.join(system, ".git", "tent-derived-node-records.json");
  await fs.writeFile(
    filename,
    JSON.stringify({
      version: 1,
      head,
      value,
      digest: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    }),
  );
  const records = await new GitDocumentHistory(system).nodeRecords();
  assert.equal(records["node-invalidated"], null);
  assert.deepEqual(records["node-unaffected"], valid);
  assert.equal((await git(system, "rev-parse", "HEAD")).trim(), head);
});

test("version 1 preserves extension fields throughout material and goal records", async (t) => {
  const { system, adapter } = await fixture(t);
  const material = {
    identity: "portable-material",
    version: "a".repeat(64),
    fingerprintVersion: 2 as const,
    extension: { selection: "summary" },
    repository: {
      commonDir: "../repository/.git",
      path: "material.md",
      blob: "b".repeat(40),
      extension: { format: "future" },
    },
  };
  const record = {
    v: 1 as const,
    materials: [material],
    goals: [
      {
        nodeId: "node-goal",
        version: "c".repeat(64),
        fingerprintVersion: 2 as const,
        materials: [material],
        extension: ["ancestor"],
      },
    ],
    extension: { uri: "https://example.invalid/material", enabled: true },
  };
  const capture = await adapter.history.captureUnlocked([], {
    operation: "test.record.extensions",
    nodeRecords: { "node-extended": record },
  });
  const reader = new GitDocumentHistory(system);
  assert.deepEqual((await reader.nodeRecords())["node-extended"], record);
  assert.deepEqual((await reader.nodeRecordEvents())[capture.commit!]?.["node-extended"], record);
  assert.deepEqual(await reader.unportableNodeRecordIds(), []);
});

test("bad declarations isolate each Node, mask old bases and use the final duplicate trailer", async (t) => {
  const { system, adapter, commitTrailers } = await fixture(t);
  const badIds = [
    "node-unversioned",
    "node-unsupported",
    "node-short",
    "node-long",
    "node-malformed",
    "node-schema",
  ];
  const valid = { v: 1 as const, materials: [], extension: "retained" };
  await adapter.history.captureUnlocked([], {
    operation: "test.record.bases",
    nodeRecords: Object.fromEntries([...badIds, "node-duplicate"].map((id) => [id, valid])),
  });
  const latest = { ...valid, extension: "latest" };
  const commit = await commitTrailers([
    trailer("node-unversioned", { materials: [] }),
    trailer("node-unsupported", { v: 2, materials: [] }),
    'Tent-Node-Record: ["node-short"]',
    'Tent-Node-Record: ["node-long",{"v":1,"materials":[]},0]',
    'Tent-Node-Record: ["node-malformed",{"v":1,"materials":',
    trailer("node-schema", { v: 1, materials: [{ identity: "material", version: "bad" }] }),
    trailer("node-good", latest),
    trailer("node-duplicate", { v: 3, materials: [] }),
    trailer("node-duplicate", latest),
    trailer("node-finalbad", latest),
    trailer("node-finalbad", { v: 7, materials: [] }),
  ]);
  const reader = new GitDocumentHistory(system);
  const records = await reader.nodeRecords();
  for (const id of [...badIds, "node-finalbad"]) assert.equal(records[id], null, id);
  assert.deepEqual(records["node-good"], latest);
  assert.deepEqual(records["node-duplicate"], latest);
  assert.deepEqual((await reader.nodeRecordEvents())[commit], records);
});

for (const hasResource of [false, true]) {
  test(`old independent output ${hasResource ? "with readable resource" : "without materials"} stays behind until confirm`, async (t) => {
    const { workspace, system, adapter, env, commitTrailers } = await fixture(t);
    const material = path.join(workspace, "material.txt");
    if (hasResource) await fs.writeFile(material, "readable bytes");
    const output = await createNode(env, {
      parentPath: "",
      name: "Output",
      type: "output",
      tags: ["asset"],
      body: "original output",
      ...(hasResource ? { resource: pathToFileURL(material).href } : {}),
    });
    const other = await createNode(env, { parentPath: "", name: "Other", type: "prompt" });
    const otherRecord = (await adapter.history.nodeRecords())[other];
    await commitTrailers([trailer(output, { materials: [] })]);
    const assertBehind = async () => {
      const fresh = new NodeFs(system);
      assert.equal((await fresh.history.nodeRecords())[output], null);
      assert.equal((await inspectNodeSync(fresh, output)).state, "behind");
      assert.deepEqual((await fresh.history.nodeRecords())[other], otherRecord);
    };
    await assertBehind();
    let current = await readNodeForEdit(adapter, output);
    await writeNodeDocument(adapter, output, {
      baseEtag: current.etag,
      frontmatter: { title: "metadata edit" },
    });
    await assertBehind();
    current = await readNodeForEdit(adapter, output);
    await writeNodesBatch(env, {
      items: [
        {
          op: "update",
          nodeId: output,
          baseEtag: current.etag,
          frontmatter: { title: "batch metadata" },
        },
      ],
    });
    await assertBehind();
    await renameNode(env, output, "Renamed Output");
    await assertBehind();
    await confirmNodeSync(adapter, output, {
      baseEtag: (await readNodeForEdit(adapter, output)).etag,
    });
    const fresh = new NodeFs(system);
    assert.equal((await inspectNodeSync(fresh, output)).state, "synced");
    const record = (await fresh.history.nodeRecords())[output]!;
    assert.equal(record.v, 1);
    assert.equal(record.materials.length, hasResource ? 1 : 0);
    if (hasResource) assert.match(record.materials[0]!.version!, /^[a-f0-9]{64}$/);
    assert.deepEqual((await fresh.history.nodeRecords())[other], otherRecord);
  });
}

test("confirm without baseline preserves behind until missing local material becomes readable", async (t) => {
  const { workspace, system, adapter, env, commitTrailers } = await fixture(t);
  const material = path.join(workspace, "missing-material.txt");
  const output = await createNode(env, {
    parentPath: "",
    name: "Missing Material Output",
    type: "output",
    tags: ["asset"],
    resource: pathToFileURL(material).href,
  });
  await commitTrailers([trailer(output, { v: 1, materials: "damaged" })]);
  assert.equal((await inspectNodeSync(new NodeFs(system), output)).state, "behind");
  await confirmNodeSync(adapter, output, {
    baseEtag: (await readNodeForEdit(adapter, output)).etag,
  });
  let fresh = new NodeFs(system);
  assert.equal((await fresh.history.nodeRecords())[output], null);
  assert.equal((await inspectNodeSync(fresh, output)).state, "behind");
  assert.ok((await readNodeForEdit(fresh, output)).frontmatter.verified);
  await fs.writeFile(material, "material is now readable");
  await confirmNodeSync(adapter, output, {
    baseEtag: (await readNodeForEdit(adapter, output)).etag,
  });
  fresh = new NodeFs(system);
  assert.equal((await inspectNodeSync(fresh, output)).state, "synced");
  const record = (await fresh.history.nodeRecords())[output]!;
  assert.equal(record.v, 1);
  assert.match(record.materials[0]!.version!, /^[a-f0-9]{64}$/);
});

test("confirm without baseline keeps remote material neutral while establishing version 1", async (t) => {
  const { system, adapter, env, commitTrailers } = await fixture(t);
  const output = await createNode(env, {
    parentPath: "",
    name: "Remote Material Output",
    type: "output",
    tags: ["evidence"],
    resource: "https://example.invalid/material.md",
  });
  await commitTrailers([trailer(output, { materials: [] })]);
  assert.equal((await inspectNodeSync(new NodeFs(system), output)).state, "behind");
  await confirmNodeSync(adapter, output, {
    baseEtag: (await readNodeForEdit(adapter, output)).etag,
  });
  const fresh = new NodeFs(system);
  const record = (await fresh.history.nodeRecords())[output]!;
  assert.equal(record.v, 1);
  assert.equal(record.materials.length, 1);
  assert.equal(record.materials[0]!.version, undefined);
  const inspection = await inspectNodeSync(fresh, output);
  assert.equal(inspection.state, "synced");
  assert.equal(inspection.behind, undefined);
  assert.equal(inspection.materials[0]!.state, "unanchored");
});

for (const location of ["overwritten", "merge side", "malformed pair"] as const) {
  for (const identity of ["C:/node-record-fixture/material.md", "\\\\?\\C:\\repo\\material.md"]) {
    test(`export rejects a ${identity.startsWith("C:") ? "drive" : "device"} path in ${location} version 1 history`, async (t) => {
      const { system, adapter, mount, commitTrailers } = await fixture(t);
      await adapter.history.captureUnlocked([], {
        operation: "test.record.initial",
        nodeRecords: { "node-portability": { v: 1, materials: [] } },
      });
      if (location === "merge side") await git(system, "checkout", "-b", "side");
      const declaration = trailer("node-portability", {
        v: 1,
        materials: [{ identity, version: "d".repeat(64), fingerprintVersion: 2 }],
      });
      await commitTrailers([
        location === "malformed pair" ? declaration.slice(0, -1) + ",0]" : declaration,
      ]);
      if (location === "malformed pair")
        assert.equal(
          (await new GitDocumentHistory(system).nodeRecords())["node-portability"],
          null,
        );
      if (location === "merge side") await git(system, "checkout", "main");
      await commitTrailers([
        trailer("node-portability", { v: 1, materials: [], extension: "clean" }),
      ]);
      if (location === "merge side") await git(system, "merge", "--no-ff", "--no-edit", "side");
      assert.equal(
        (await new GitDocumentHistory(system).nodeRecords())["node-portability"]?.extension,
        "clean",
      );
      await assert.rejects(
        exportGraph(mount, { outputDir: "output/rejected" }),
        /local machine paths/,
      );
      await assert.rejects(fs.stat(path.join(mount.workspaceRoot, "output", "rejected")), {
        code: "ENOENT",
      });
    });
  }
}

for (const uri of ["file:///node-record-fixture/private.md", "file://server/share/private.md"]) {
  test(`portability object audit rejects embedded JSON ${uri} during capture and export`, async (t) => {
    const { adapter, mount, commitTrailers } = await fixture(t);
    const record = {
      v: 1 as const,
      materials: [
        {
          identity: JSON.stringify(["uri", uri]),
          version: "a".repeat(64),
          fingerprintVersion: 2 as const,
        },
      ],
    };
    await assert.rejects(
      adapter.history.captureUnlocked([], {
        operation: "test.record.embedded-uri",
        nodeRecords: { "node-embedded": record },
      }),
      /local machine paths/,
    );
    await commitTrailers([trailer("node-embedded", record)]);
    assert.equal((await adapter.history.nodeRecords())["node-embedded"], null);
    await assert.rejects(
      exportGraph(mount, { outputDir: "output/rejected" }),
      /local machine paths/,
    );
  });
}

test("portability object audit rejects a polluted commit after reset and reflog expiry", async (t) => {
  const { system, adapter, mount, commitTrailers } = await fixture(t);
  const base = await adapter.history.captureUnlocked([], {
    operation: "test.record.portable-base",
    nodeRecords: { "node-dangling": { v: 1, materials: [] } },
  });
  const dirty = await commitTrailers([
    trailer("node-dangling", {
      v: 1,
      materials: [
        {
          identity: "C:/node-record-fixture/private.md",
          version: "a".repeat(64),
          fingerprintVersion: 2,
        },
      ],
    }),
  ]);
  await git(system, "reset", "--hard", base.commit!);
  await git(system, "reflog", "expire", "--expire=now", "--all");
  assert.equal((await git(system, "cat-file", "-t", dirty)).trim(), "commit");
  assert.equal(
    (await git(system, "log", "--all", "--reflog", "--format=%H")).includes(dirty),
    false,
  );
  assert.deepEqual((await new GitDocumentHistory(system).nodeRecords())["node-dangling"], {
    v: 1,
    materials: [],
  });
  await assert.rejects(exportGraph(mount, { outputDir: "output/rejected" }), /local machine paths/);
});

const keyPathCases = [
  {
    name: "top-level drive",
    fields: { "C:/node-record-key-fixture/private.md": "ordinary value" },
  },
  {
    name: "nested device",
    fields: { extension: { "\\\\?\\C:\\record-key\\private.md": "ordinary value" } },
  },
  {
    name: "deep POSIX",
    fields: {
      extension: { nested: [{ "/node-record-key-fixture/private.md": "ordinary value" }] },
    },
  },
  {
    name: "JSON-encoded UNC object",
    fields: {
      extension: {
        [JSON.stringify({ "\\\\server\\share\\private.md": "ordinary value" })]: "ordinary value",
      },
    },
  },
];

test("portability key audit rejects a version 2 same-HEAD cache with absolute keys", async (t) => {
  const { system, commitTrailers } = await fixture(t);
  const bad = {
    v: 1,
    materials: [],
    extension: { "C:/node-record-key-fixture/private.md": "ordinary value" },
  };
  const portable = { v: 1, materials: [], extension: { portableKey: "ordinary value" } };
  const head = await commitTrailers([
    trailer("node-keycache", bad),
    trailer("node-portable", portable),
  ]);
  const value = { "node-keycache": bad, "node-portable": portable };
  await fs.writeFile(
    path.join(system, ".git", "tent-derived-node-records.json"),
    JSON.stringify({
      version: 2,
      head,
      value,
      digest: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    }),
  );
  const records = await new GitDocumentHistory(system).nodeRecords();
  assert.equal(records["node-keycache"], null);
  assert.deepEqual(records["node-portable"], portable);
  assert.equal((await git(system, "rev-parse", "HEAD")).trim(), head);
});

for (const { name, fields } of keyPathCases) {
  test(`portability key audit rejects ${name} extension keys`, async (t) => {
    const { system, adapter, mount, commitTrailers } = await fixture(t);
    const portable = {
      v: 1 as const,
      materials: [],
      extension: {
        portableKey: "ordinary value",
        [JSON.stringify({ portable: true })]: "JSON key",
      },
    };
    const base = await adapter.history.captureUnlocked([], {
      operation: "test.record.portable-keys",
      nodeRecords: { "node-portable": portable },
    });
    assert.deepEqual((await adapter.history.nodeRecords())["node-portable"], portable);
    const record = { v: 1 as const, materials: [], ...fields };
    await t.test("capture rejects and leaves HEAD unchanged", async () => {
      await assert.rejects(
        adapter.history.captureUnlocked([], {
          operation: "test.record.absolute-keys",
          nodeRecords: { "node-keypath": record },
        }),
        /local machine paths/,
      );
      assert.equal((await git(system, "rev-parse", "HEAD")).trim(), base.commit);
    });
    await t.test("injected history is unreadable and cannot be exported", async () => {
      await commitTrailers([trailer("node-keypath", record)]);
      await assert.rejects(
        exportGraph(mount, { outputDir: "output/key-rejected" }),
        /local machine paths/,
      );
      const reader = new GitDocumentHistory(system);
      assert.equal((await reader.nodeRecords())["node-keypath"], null);
      assert.deepEqual((await reader.nodeRecords())["node-portable"], portable);
      assert.deepEqual(await reader.unportableNodeRecordIds(), ["node-keypath"]);
      await assert.rejects(fs.stat(path.join(mount.workspaceRoot, "output", "key-rejected")), {
        code: "ENOENT",
      });
    });
  });
}

test("portability key audit retains unversioned absolute repository locators as identical Git object bytes", async (t) => {
  const { workspace, system, adapter, mount, commitTrailers } = await fixture(t);
  const record = {
    extension: Object.assign({}, ...keyPathCases.map(({ fields }) => fields)),
    materials: [
      {
        identity: "legacy-material",
        version: "e".repeat(64),
        repository: {
          commonDir: "C:/node-record-fixture/old-repository/.git",
          path: "material.md",
          blob: "f".repeat(40),
        },
      },
    ],
  };
  const commit = await commitTrailers([trailer("node-legacy", record)]);
  const object = path.join(".git", "objects", commit.slice(0, 2), commit.slice(2));
  const before = await fs.readFile(path.join(system, object));
  const message = await git(system, "cat-file", "commit", commit);
  assert.equal((await adapter.history.nodeRecords())["node-legacy"], null);
  await exportGraph(mount, { outputDir: "output/legacy" });
  const copied = path.join(workspace, "output", "legacy", ".tent");
  assert.deepEqual(await fs.readFile(path.join(copied, object)), before);
  assert.deepEqual(await fs.readFile(path.join(system, object)), before);
  assert.equal(await git(copied, "cat-file", "commit", commit), message);
  assert.ok(message.includes("C:/node-record-fixture/old-repository/.git"));
  assert.ok(message.includes("C:/node-record-key-fixture/private.md"));
});
