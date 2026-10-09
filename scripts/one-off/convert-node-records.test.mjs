import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tsImport } from "tsx/esm/api";
import { convertRecord, convertWorkspace } from "./convert-node-records.mjs";
const { nodeMaterialFingerprint } = await tsImport(
  "../../src/core/node-sync-record.ts",
  import.meta.url,
);

const scratch = fileURLToPath(new URL("../../.scratch/", import.meta.url));
const script = fileURLToPath(new URL("./convert-node-records.mjs", import.meta.url));
const basis = {
  materials: [{ identity: "resource:source.txt", version: "a".repeat(64), fingerprintVersion: 2 }],
};
const trailer = (id, record) => `Tent-Node-Record: ${JSON.stringify([id, record])}`;
function fixture(t) {
  fs.mkdirSync(scratch, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(scratch, "record-conversion-"));
  t.after(() =>
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }),
  );
  const root = path.join(workspace, ".tent");
  fs.mkdirSync(root);
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  git("init", "-q", "--initial-branch=main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@localhost");
  git("config", "core.autocrlf", "false");
  for (const id of ["node-a", "node-b", "node-c"]) {
    fs.mkdirSync(path.join(root, id));
    fs.writeFileSync(path.join(root, id, id + ".md"), `---\nid: ${id}\ntype: prompt\n---\nBody\n`);
  }
  fs.mkdirSync(path.join(root, "cards"));
  fs.writeFileSync(path.join(root, "cards/card-pin.md"), "Card pinned bytes\n");
  git("add", ".");
  git("commit", "-qm", "initial");
  const append = (message, parent = "HEAD", otherParent) => {
    const args = ["commit-tree", git("rev-parse", "HEAD^{tree}").trim(), "-p", parent];
    if (otherParent) args.push("-p", otherParent);
    const commit = git(...args, "-m", message).trim();
    git("update-ref", "HEAD", commit);
    return commit;
  };
  return { workspace, root, git, append };
}

test("preserves complete material and goal baselines, relativizes both repository fields", () => {
  const material = {
    ...basis.materials[0],
    repository: {
      commonDir: "C:/project/.git",
      path: "source.txt",
      blob: "b".repeat(40),
      extra: true,
    },
  };
  const input = {
    materials: [material],
    goals: [
      {
        nodeId: "node-goal",
        version: "c".repeat(64),
        fingerprintVersion: 2,
        materials: [material],
      },
    ],
    extra: { keep: 5 },
  };
  const before = structuredClone(input),
    expected = structuredClone(input);
  expected.v = 1;
  expected.materials[0].repository.commonDir = ".git";
  expected.goals[0].materials[0].repository.commonDir = ".git";
  assert.deepEqual(convertRecord(input, "C:/project"), expected);
  assert.deepEqual(input, before);
  assert.throws(() => convertRecord(input, "D:/project"), /cannot be made relative/);
  assert.throws(() =>
    convertRecord(
      { materials: [{ ...basis.materials[0], fingerprintVersion: undefined }] },
      "C:/project",
    ),
  );
  assert.throws(
    () => convertRecord({ materials: [], extra: 'resource:["C:/private"]' }, "C:/project"),
    /local machine path/,
  );
});

test("dry run writes nothing; append keeps tree and Card pins, product reader accepts, second run is idle", async (t) => {
  const f = fixture(t),
    v1 = { v: 1, materials: [] };
  f.append(
    [trailer("node-a", basis), trailer("node-b", v1), trailer("node-deleted", basis)].join("\n"),
  );
  const before = f.git("rev-parse", "HEAD").trim(),
    tree = f.git("rev-parse", "HEAD^{tree}").trim();
  const objects = f.git("count-objects", "-v");
  const plan = convertWorkspace(f.workspace, { dryRun: true });
  assert.deepEqual(plan.converted, ["node-a"]);
  assert.deepEqual(plan.skippedV1, ["node-b"]);
  assert.deepEqual(plan.missing, ["node-c"]);
  assert.equal(f.git("rev-parse", "HEAD").trim(), before);
  assert.equal(f.git("count-objects", "-v"), objects);
  const report = convertWorkspace(f.workspace);
  assert.equal(f.git("rev-parse", "HEAD^{tree}").trim(), tree);
  assert.equal(f.git("rev-parse", "HEAD^").trim(), before);
  assert.equal(f.git("status", "--porcelain").trim(), "");
  assert.equal(
    fs.readFileSync(path.join(f.root, "cards/card-pin.md"), "utf8"),
    "Card pinned bytes\n",
  );
  const records = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { NodeFs } from ${JSON.stringify(new URL("../../src/fs/node-fs.ts", import.meta.url).href)}; console.log(JSON.stringify(await new NodeFs(${JSON.stringify(f.root)}).history.nodeRecords()));`,
      ],
      { encoding: "utf8", windowsHide: true },
    ),
  );
  assert.deepEqual(records["node-a"], { ...basis, v: 1 });
  assert.equal(convertWorkspace(f.workspace).commit, null);
  assert.equal(f.git("rev-parse", "HEAD").trim(), report.commit);
});

test("latest first-parent declaration and last trailer win, merged side records do not", (t) => {
  const f = fixture(t),
    first = f.append(trailer("node-a", basis));
  const side = f.append(trailer("node-a", { materials: [{ identity: "side" }] }));
  f.git("update-ref", "HEAD", first);
  f.append(
    [
      trailer("node-b", { materials: [{ identity: "earlier" }] }),
      trailer("node-b", { materials: [{ identity: "last" }] }),
    ].join("\n"),
    first,
    side,
  );
  const report = convertWorkspace(f.workspace);
  const message = f.git("show", "-s", "--format=%B", report.commit);
  assert.ok(message.includes(trailer("node-a", { ...basis, v: 1 })));
  assert.ok(message.includes(trailer("node-b", { materials: [{ identity: "last" }], v: 1 })));
});

test("corrupt newest record blocks every conversion and CLI reports all failures with exit 1", (t) => {
  const f = fixture(t);
  f.append(trailer("node-a", basis));
  f.append(
    'Tent-Node-Record: ["node-a", broken\n' +
      trailer("node-b", basis) +
      "\n" +
      trailer("node-c", { v: 2, materials: [] }),
  );
  const before = f.git("rev-parse", "HEAD").trim(),
    reportPath = path.join(f.workspace, "report.json");
  const result = spawnSync(process.execPath, [script, f.workspace, "--report", reportPath], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(reportPath, "utf8")).failed.map((item) => item.id),
    ["node-a", "node-c"],
  );
  assert.equal(f.git("rev-parse", "HEAD").trim(), before);
  f.append(
    trailer("node-b", { materials: [{ identity: "node:node-c", version: "not-a-fingerprint" }] }),
  );
  const invalidHead = f.git("rev-parse", "HEAD").trim();
  const invalid = convertWorkspace(f.workspace);
  assert.deepEqual(
    invalid.failed.map((item) => item.id),
    ["node-a", "node-b", "node-c"],
  );
  assert.deepEqual(invalid.materialDecisions, []);
  assert.equal(f.git("rev-parse", "HEAD").trim(), invalidHead);
});

test("uncaptured document edits and an active writer prevent publication", (t) => {
  const f = fixture(t);
  f.append(trailer("node-a", basis));
  fs.writeFileSync(path.join(f.root, "node-a/node-a.md"), "changed");
  assert.throws(() => convertWorkspace(f.workspace), /Capture all/);
  f.git("restore", "node-a/node-a.md");
  fs.writeFileSync(path.join(f.root, ".gitignore"), "mutation.lock\n");
  f.git("add", ".gitignore");
  f.git("commit", "-qm", "ignore lock");
  fs.writeFileSync(path.join(f.root, "mutation.lock"), "owner");
  assert.throws(() => convertWorkspace(f.workspace), /pending operations/);
});

test("missing algorithms use the record commit's Node section and Card bytes, never current files", (t) => {
  const f = fixture(t);
  const raw = "---\nid: node-b\ntype: prompt\n---\n# Kept\n历史材料\n# Other\nOther\n";
  fs.writeFileSync(path.join(f.root, "node-b/node-b.md"), raw);
  f.git("add", ".");
  f.git("commit", "-qm", "retained material");
  const nodeVersion = nodeMaterialFingerprint(raw, {
    kind: "path",
    anchor: "bundle",
    target: "node-b/node-b.md",
    suffix: "#Kept",
  });
  const cardVersion = createHash("sha256").update("Card pinned bytes\n").digest("hex");
  const original = {
    materials: [
      { identity: "node:node-b#Kept", version: nodeVersion, extra: "preserved" },
      { identity: '["path","cards/card-pin.md",""]', version: cardVersion },
      { identity: "node:node-b#Kept", version: "f".repeat(64) },
      { identity: '["path","gone.txt",""]', version: "e".repeat(64) },
      { identity: '["uri","https://example.org"]' },
    ],
    goals: [
      {
        nodeId: "node-c",
        version: "c".repeat(64),
        fingerprintVersion: 2,
        materials: [{ identity: "node:node-b#Kept", version: nodeVersion }],
      },
    ],
  };
  const recordedAt = f.append(trailer("node-a", original));
  fs.writeFileSync(
    path.join(f.root, "node-b/node-b.md"),
    raw.replace("历史材料", "changed current material"),
  );
  fs.writeFileSync(path.join(f.root, "cards/card-pin.md"), "changed current Card\n");
  f.git("add", ".");
  f.git("commit", "-qm", "new material is not proof");
  const before = f.git("rev-parse", "HEAD").trim(),
    objects = f.git("count-objects", "-v");
  const plan = convertWorkspace(f.workspace, { dryRun: true });
  assert.deepEqual(plan.failed, []);
  assert.deepEqual(
    plan.materialDecisions.map((row) => row.action),
    ["proved-v2", "proved-v2", "removed-version", "removed-version", "proved-v2"],
  );
  assert.ok(plan.materialDecisions.every((row) => row.commit === recordedAt));
  assert.equal(f.git("rev-parse", "HEAD").trim(), before);
  assert.equal(f.git("count-objects", "-v"), objects);
  const applied = convertWorkspace(f.workspace);
  assert.deepEqual(applied.materialDecisions, plan.materialDecisions);
  const line = f
    .git("show", "-s", "--format=%B", applied.commit)
    .split("\n")
    .find((line) => line.startsWith("Tent-Node-Record: "));
  const [, converted] = JSON.parse(line.slice(18));
  const expected = structuredClone(original);
  expected.v = 1;
  expected.materials[0].fingerprintVersion = 2;
  expected.materials[1].fingerprintVersion = 2;
  delete expected.materials[2].version;
  delete expected.materials[3].version;
  expected.goals[0].materials[0].fingerprintVersion = 2;
  assert.deepEqual(converted, expected);
  assert.equal(convertWorkspace(f.workspace).commit, null);
});
