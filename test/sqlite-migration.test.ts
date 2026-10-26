import { openTestFs, removeTestFixture } from "./node-fs.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { NodeFs } from "../src/fs/node-fs.js";
import { DatabaseSync } from "../src/fs/sqlite-runtime.js";
import { importGitHistory, convertHistoryPins } from "../src/fs/import-git-history.js";
import { tentIndexMarker } from "../src/core/store/scaffold.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/base/frontmatter.js";
import { verifyCardSourceVersion } from "../src/core/graph/card-document.js";
import { git } from "./helpers.js";
import { testScratchRoot } from "./scratch.js";
import type { DocumentVersion } from "../src/core/store/history-port.js";
import { cardSourceIdentityError } from "../src/core/graph/card-context.js";
import { createHash } from "node:crypto";

async function fixture(t: TestContext) {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "sqlite-migration-")),
    source = path.join(workspace, "source/.tent"),
    target = path.join(workspace, "target/.tent");
  await fs.mkdir(source, { recursive: true });
  await git(source, "init", "--initial-branch=main");
  await git(source, "config", "core.autocrlf", "false");
  await fs.writeFile(path.join(source, "index.md"), tentIndexMarker());
  await fs.writeFile(
    path.join(source, "settings.json"),
    JSON.stringify({ workspaceId: "ws-migration" }),
  );
  const write = async (file: string, raw: string | Buffer) => {
    await fs.mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await fs.writeFile(path.join(source, file), raw);
  };
  const commit = async (message: string) => {
    await git(source, "add", "--all");
    await git(source, "commit", "--quiet", "-m", message);
    return (await git(source, "rev-parse", "HEAD")).trim();
  };
  t.after(() =>
    removeTestFixture(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  return { workspace, source, target, write, commit };
}

test("migration rewrites only exact pin scalars, audits nested historical targets, and preserves dirty/binary current files", async (t) => {
  const f = await fixture(t),
    goal =
      "---\r\nid: node-goal\r\ntype: goal\r\ncustom: 'keep me' # comment\r\n---\r\nOLD GOAL\r\n";
  await f.write("Goal/Goal.md", goal);
  const first = await f.commit("first legacy event");
  const output = `---\r\nid: node-output\r\ntype: output\r\nsources:\r\n  - resource: ../Goal/Goal.md\r\n    version: {commit: '${first}', path: Goal/Goal.md} # pin only\r\n---\r\nOUTPUT mentioning ${first} in ordinary prose\r\n`;
  await f.write("Output/Output.md", output);
  const second = await f.commit("second legacy event");
  await f.write(
    "cards/card-input.md",
    serializeFrontmatter(
      {
        type: "card",
        id: "card-input",
        schemaVersion: 3,
        state: "pending",
        sources: [
          {
            resource: "../Output/Output.md",
            version: { commit: second, path: "Output/Output.md" },
          },
        ],
      },
      "fixed source",
    ),
  );
  await f.write("Goal/Goal.md", goal.replace("OLD GOAL", "RETAINED CURRENT"));
  await f.commit("current legacy event");
  const external = goal.replace("OLD GOAL", "EXTERNAL CURRENT");
  await f.write("Goal/Goal.md", external);
  await f.write("Fresh/Fresh.md", "---\nid: node-fresh\ntype: prompt\n---\nUNRETAINED\n");
  const binary = Buffer.from([0, 255, 128, 1]);
  await f.write("assets/data.bin", binary);
  await fs.mkdir(path.join(f.source, "empty-group"));
  const result = await importGitHistory(f.source, f.target);
  assert.equal(result.events, 3);
  assert.ok(result.pins.length >= 3);
  assert.ok(result.pins.every((p) => p.verified));
  assert.ok(
    result.pins.some(
      (p) =>
        p.target.path === "Output/Output.md" &&
        !p.exactOriginalBytes &&
        p.targetReplacements.length === 1,
    ),
  );
  assert.ok(result.uncaptured.some((p) => p.path === "Goal/Goal.md" && p.kind === "external-edit"));
  assert.ok(result.uncaptured.some((p) => p.path === "Fresh/Fresh.md" && p.kind === "unretained"));
  assert.equal(await fs.readFile(path.join(f.target, "Goal/Goal.md"), "utf8"), external);
  assert.deepEqual(await fs.readFile(path.join(f.target, "assets/data.bin")), binary);
  assert.ok((await fs.stat(path.join(f.target, "empty-group"))).isDirectory());
  const converted = await fs.readFile(path.join(f.target, "Output/Output.md"), "utf8"),
    expected = output.replace(`commit: '${first}'`, `commit: '${result.mapping[first]}'`);
  assert.equal(converted, expected);
  assert.ok(converted.includes(`OUTPUT mentioning ${first} in ordinary prose`));
  const adapter = openTestFs(f.target);
  try {
    const card = parseFrontmatter(await adapter.readFile("cards/card-input.md"));
    const source = (card.data.sources as { resource: string; version: DocumentVersion }[])[0]!;
    const pinned = await verifyCardSourceVersion(adapter, "cards/card-input.md", source);
    assert.equal(pinned.raw, expected);
    const nested = (parseFrontmatter(pinned.raw).data.sources as { version: DocumentVersion }[])[0]!
      .version;
    assert.equal(await adapter.history.read(nested), goal);
    await assert.rejects(
      adapter.history.read({ commit: first, path: "Goal/Goal.md" }),
      /Invalid SQLite event/,
    );
  } finally {
    await adapter.close();
  }
  const db = new DatabaseSync(path.join(f.target, ".git/history.sqlite"));
  try {
    const raw = db
      .prepare("SELECT raw FROM migration_originals WHERE event=? AND path=?")
      .get(result.mapping[second]!, "Output/Output.md")!;
    assert.deepEqual(Buffer.from(raw.raw as Uint8Array), Buffer.from(output));
    assert.deepEqual(
      db
        .prepare("PRAGMA table_info(migration_events)")
        .all()
        .map((r) => r.name),
      ["event", "message"],
    );
  } finally {
    db.close();
  }
  assert.equal(await fs.readFile(path.join(f.source, "Goal/Goal.md"), "utf8"), external);
  assert.equal(
    await fs.access(path.join(f.target, ".git/HEAD")).then(
      () => true,
      () => false,
    ),
    false,
  );
});

for (const type of ["prompt", "invalid-node-type"]) {
  test(`migration audits historical target identity ${type} without repairing it`, async (t) => {
    const f = await fixture(t),
      anchor = "---\nid: node-anchor\ntype: goal\n---\nANCHOR\n";
    await f.write("Anchor/Anchor.md", anchor);
    const first = await f.commit("anchor");
    const original = `---\r\nid: node-target\r\ntype: ${type}\r\ncustom: {version: {commit: ${first}, path: unchanged.md}}\r\nsources:\r\n - resource: ../Anchor/Anchor.md\r\n   version: {commit: '${first}', path: Anchor/Anchor.md} # exact scalar\r\n---\r\nHISTORICAL ${first}\r\n`;
    await f.write("Target/Target.md", original);
    const pinned = await f.commit("historical target");
    for (const owner of ["cards/card-pin.md", "Output/Output.md"])
      await f.write(
        owner,
        `---\nid: ${owner.startsWith("cards/") ? "card-pin\ntype: card\nschemaVersion: 3\nstate: pending" : "node-output\ntype: output"}\nsources:\n - resource: ../Target/Target.md\n   version: {commit: ${pinned}, path: Target/Target.md}\n---\nFIXED\n`,
      );
    await f.write(
      "Target/Target.md",
      original.replace(`type: ${type}`, "type: prompt").replace("HISTORICAL", "CURRENT"),
    );
    await f.commit("current is valid but pins retain historical target");
    const beforeDiagnostic = cardSourceIdentityError(
        "Target/Target.md",
        original,
        parseFrontmatter(original).data,
      ),
      result = await importGitHistory(f.source, f.target),
      rows = result.pins.filter((pin) => pin.source.commit === pinned),
      expected = original.replace(`commit: '${first}'`, `commit: '${result.mapping[first]}'`),
      adapter = openTestFs(f.target),
      sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
    try {
      assert.equal(
        rows.length,
        4,
        "Card and output pins occur in both retained and current documents",
      );
      const actual = await adapter.history.read(rows[0]!.target),
        afterDiagnostic = cardSourceIdentityError(
          "Target/Target.md",
          actual,
          parseFrontmatter(actual).data,
        );
      assert.equal(actual, expected);
      assert.equal(afterDiagnostic, beforeDiagnostic);
      assert.equal(
        beforeDiagnostic,
        type === "prompt" ? null : "Node type must be goal, prompt or output.",
      );
      const cardSource = {
        resource: "../Target/Target.md",
        version: rows[0]!.target,
      };
      if (beforeDiagnostic)
        await assert.rejects(
          verifyCardSourceVersion(adapter, "cards/card-pin.md", cardSource),
          (error: Error) => error.message === beforeDiagnostic,
        );
      else
        assert.equal(
          (await verifyCardSourceVersion(adapter, "cards/card-pin.md", cardSource)).raw,
          expected,
        );
      assert.ok((await adapter.readFile("Target/Target.md")).includes("CURRENT"));
      for (const row of rows) {
        assert.deepEqual(row.diagnostics, { before: beforeDiagnostic, after: afterDiagnostic });
        assert.equal(row.verified, type === "prompt");
        assert.equal(row.status, type === "prompt" ? "verified" : "originally-invalid-preserved");
        assert.equal(row.originalSha256, sha(original));
        assert.equal(row.expectedConvertedSha256, sha(expected));
        assert.equal(row.actualConvertedSha256, sha(actual));
        assert.equal(row.targetReplacements.length, 1);
      }
      assert.deepEqual(result.preservedInvalidPins, type === "prompt" ? [] : rows);
      assert.ok(
        result.pins
          .filter((pin) => pin.source.path === "Anchor/Anchor.md")
          .every((pin) => pin.verified),
      );
      const db = new DatabaseSync(path.join(f.target, ".git/history.sqlite"));
      try {
        const retained = db
          .prepare("SELECT raw FROM migration_originals WHERE event=? AND path=?")
          .get(result.mapping[pinned]!, "Target/Target.md")!;
        assert.deepEqual(Buffer.from(retained.raw as Uint8Array), Buffer.from(original));
      } finally {
        db.close();
      }
      console.log(
        JSON.stringify({
          case: type,
          beforeDiagnostic,
          afterDiagnostic,
          original,
          expected,
          actual,
          pins: rows,
          preservedInvalidPins: result.preservedInvalidPins.length,
        }),
      );
    } finally {
      await adapter.close();
    }
  });
}

test("illegal/unmapped pin metadata is rejected without changing ordinary hashes or prose", () => {
  const old = "a".repeat(40),
    mapped = "b".repeat(64),
    mapping = new Map([[old, mapped]]);
  const raw = `---\nid: node-test\ntype: prompt\ncustom: ${old}\nsources:\n - resource: ../Goal/Goal.md\n   version: {commit: ${old}, path: Goal/Goal.md}\n---\n${old}\n`;
  assert.equal(
    convertHistoryPins(raw, mapping, "Output/Output.md").raw,
    raw.replace(`commit: ${old}`, `commit: ${mapped}`),
  );
  assert.throws(
    () => convertHistoryPins(raw, new Map(), "Output/Output.md"),
    /Unmapped history event/,
  );
  assert.throws(
    () =>
      convertHistoryPins(
        raw.replace("../Goal/Goal.md", "../Other/Other.md"),
        mapping,
        "Output/Output.md",
      ),
    /Fixed source resource/,
  );
  assert.throws(
    () =>
      convertHistoryPins(
        raw.replace("../Goal/Goal.md", "file:///offline-original/.tent/Goal/Goal.md"),
        mapping,
        "Output/Output.md",
      ),
    /Fixed source resource/,
  );
  assert.throws(
    () =>
      convertHistoryPins(
        raw.replace("path: Goal/Goal.md", "path: ../Goal/Goal.md"),
        mapping,
        "Output/Output.md",
      ),
    /Invalid fixed address/,
  );
  assert.throws(
    () =>
      convertHistoryPins(
        raw.replace(`{commit: ${old}, path: Goal/Goal.md}`, "null"),
        mapping,
        "Output/Output.md",
      ),
    /Invalid fixed version/,
  );
});

test("unknown metadata version objects are preserved rather than inferred as material pins", () => {
  const old = "a".repeat(40),
    mapped = "b".repeat(64);
  const extension = `custom: {version: {commit: ${old}, path: Goal/Goal.md}}`;
  const raw = `---\nid: node-test\ntype: prompt\n${extension}\nsources:\n - resource: ../Goal/Goal.md\n   version: {commit: ${old}, path: Goal/Goal.md}\n---\nKeep ${old}\n`;
  const result = convertHistoryPins(raw, new Map([[old, mapped]]), "Output/Output.md");
  assert.equal(
    result.raw,
    raw.replace(`   version: {commit: ${old}`, `   version: {commit: ${mapped}`),
  );
  assert.equal(result.pins.length, 1);
  const onlyExtension = `---\nid: node-test\ntype: prompt\n${extension}\n---\n`;
  assert.equal(convertHistoryPins(onlyExtension, new Map(), "Output/Output.md").raw, onlyExtension);
});

test("migration conservatively rejects real merge history before creating its target", async (t) => {
  const f = await fixture(t);
  await f.write("A/A.md", "---\nid: node-a\ntype: prompt\n---\nA");
  await f.commit("base");
  await git(f.source, "checkout", "-b", "side");
  await f.write("B/B.md", "---\nid: node-b\ntype: prompt\n---\nB");
  await f.commit("side");
  await git(f.source, "checkout", "main");
  await f.write("C/C.md", "---\nid: node-c\ntype: prompt\n---\nC");
  await f.commit("main");
  await git(f.source, "merge", "--no-ff", "--no-edit", "side");
  await assert.rejects(
    importGitHistory(f.source, f.target),
    /Merge history requires an explicit migration decision/,
  );
  assert.equal(
    await fs.access(f.target).then(
      () => true,
      () => false,
    ),
    false,
  );
});

test("an unborn empty legacy workspace migrates without inventing a history event", async (t) => {
  const f = await fixture(t),
    result = await importGitHistory(f.source, f.target);
  assert.equal(result.events, 0);
  assert.equal(result.sourceHead, null);
  assert.equal(result.targetHead, null);
  const target = openTestFs(f.target);
  try {
    assert.equal(await target.history.currentCommit(), null);
  } finally {
    await target.close();
  }
});

test("migration preserves accepted uppercase identity metadata on record-only events", async (t) => {
  const f = await fixture(t);
  await f.write("Upper/Upper.md", "---\nid: NODE-UPPER\ntype: prompt\n---\nExact input\n");
  await f.commit("Initial uppercase document");
  await git(
    f.source,
    "commit",
    "--allow-empty",
    "--quiet",
    "-m",
    "Tent-Operation: node.confirm\nTent-Object: NODE-UPPER\nTent-Entry: core",
  );
  await importGitHistory(f.source, f.target);
  const adapter = openTestFs(f.target);
  try {
    const events = await adapter.history.changesInRange();
    assert.equal(events.length, 2);
    assert.equal((await adapter.history.nodeVersions("NODE-UPPER")).length, 1);
    assert.equal(events[1]!.operation, "node.confirm");
    assert.deepEqual(events[1]!.objectIds, ["NODE-UPPER"]);
    assert.deepEqual(events[1]!.changes, []);
  } finally {
    await adapter.close();
  }
});
