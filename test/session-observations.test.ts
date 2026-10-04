import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { observeSessionFile } from "../src/fs/session-observations.js";
import {
  appendSessionObservations,
  readRecentSessionObservations,
  readSessionObservations,
  sessionObservationPath,
  type SessionObservationActivity,
} from "../src/core/session-observations.js";

async function fixture(t: TestContext) {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "observations-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  await fs.mkdir(path.join(workspace, ".tent"));
  return { root, workspace, adapter: new NodeFs(path.join(workspace, ".tent")) };
}
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const empty: SessionObservationActivity = { observations: [], signals: [], uncertain: false };

test("turn event persists addresses and Stop versions, never payload/content; host ids cannot become paths", async (t) => {
  const { root, workspace, adapter } = await fixture(t);
  const secret = "business file body SECRET",
    userText = "CHAT SECRET",
    toolText = "TOOL SECRET";
  await fs.writeFile(path.join(workspace, "source.bin"), secret);
  const outside = path.join(root, "outside.txt");
  await fs.writeFile(outside, "outside");
  const session = "../../somewhere\\bad/session";
  const result = await appendSessionObservations(
    adapter,
    session,
    "turn-1",
    {
      observations: [
        { kind: "provided", address: pathToFileURL(outside).href },
        { kind: "read", address: "source.bin", eventAt: "2026-10-04T00:00:00Z", content: secret },
        { kind: "written", address: "source.bin" },
      ],
      signals: ["possible-requirement", "possible-decision"],
      uncertain: false,
      message: userText,
      output: toolText,
    } as SessionObservationActivity,
    (address) => observeSessionFile(workspace, address),
  );
  assert.equal(result.appended, true);
  assert.match(sessionObservationPath(session), /^temp\/observations\/[a-f0-9]{64}\.jsonl$/);
  assert.equal(result.event.sessionId, session);
  assert.equal(result.event.files.length, 3);
  const version = result.event.files[1]!.version;
  assert.equal(version.state, "observed");
  assert.equal(version.phase, "stop");
  if (version.state === "observed") assert.equal(version.sha256, sha(secret));
  assert.notEqual(result.event.files[1]!.eventAt, version.observedAt);
  const raw = await adapter.readFile(sessionObservationPath(session));
  for (const value of [secret, userText, toolText]) assert.equal(raw.includes(value), false);
  assert.deepEqual(await readRecentSessionObservations(adapter), {
    events: [result.event],
    uncertain: false,
  });
});

test("same turn and duplicate events are idempotent, including cancellation and simultaneous Stop", async (t) => {
  const { adapter } = await fixture(t);
  let hashes = 0;
  const observer = async () => {
    hashes++;
    return { observedVersion: sha("v1") };
  };
  const activity: SessionObservationActivity = {
    observations: [
      { kind: "written", address: "file.txt" },
      { kind: "written", address: "file.txt" },
    ],
    signals: [],
    uncertain: false,
    cancelled: true,
  };
  const first = await appendSessionObservations(adapter, "session", "turn", activity, observer);
  const raw = await adapter.readFile(sessionObservationPath("session"));
  const second = await appendSessionObservations(adapter, "session", "turn", empty, observer);
  assert.deepEqual(second.event, first.event);
  assert.equal(second.appended, false);
  assert.equal(hashes, 1);
  assert.equal(first.event.cancelled, true);
  assert.equal(first.event.files.length, 1);
  assert.equal(await adapter.readFile(sessionObservationPath("session")), raw);
  // NodeFs's lock deliberately fails fast on overlap; a retry must remain idempotent.
  const attempts = await Promise.allSettled([
    appendSessionObservations(adapter, "session", "turn-2", empty, observer),
    appendSessionObservations(adapter, "session", "turn-2", empty, observer),
  ]);
  assert.ok(attempts.some((attempt) => attempt.status === "fulfilled"));
  await appendSessionObservations(adapter, "session", "turn-2", empty, observer);
  assert.equal((await readSessionObservations(adapter)).events.length, 2);
});

test("safe streamed hashes support binary data and outside URIs; unavailable paths are uncertain", async (t) => {
  const { root, workspace, adapter } = await fixture(t);
  const bytes = Buffer.alloc(200000, 255);
  await fs.writeFile(path.join(workspace, "large.bin"), bytes);
  assert.equal((await observeSessionFile(workspace, "large.bin")).observedVersion, sha(bytes));
  const outside = path.join(root, "outside.bin");
  await fs.writeFile(outside, bytes);
  assert.equal(
    (await observeSessionFile(workspace, pathToFileURL(outside).href)).observedVersion,
    sha(bytes),
  );
  await assert.rejects(observeSessionFile(workspace, "../outside.bin"));
  await assert.rejects(observeSessionFile(workspace, "https://example.invalid/file"));
  await assert.rejects(observeSessionFile(workspace, "file://remote-server/share/file.txt"));
  await assert.rejects(observeSessionFile(workspace, "file:////remote-server/share/file.txt"));
  await assert.rejects(observeSessionFile(workspace, ".tent"));
  const result = await appendSessionObservations(
    adapter,
    "session",
    "turn",
    {
      observations: [{ kind: "written", address: "deleted.txt" }],
      signals: [],
      uncertain: false,
    },
    (address) => observeSessionFile(workspace, address),
  );
  assert.equal(result.event.uncertain, true);
  assert.equal(result.event.files[0]!.version.state, "uncertain");
  assert.equal("sha256" in result.event.files[0]!.version, false);
  await assert.rejects(
    appendSessionObservations(
      adapter,
      "session",
      "bad-address",
      {
        observations: [{ kind: "read", address: "../outside.bin" }],
        signals: [],
        uncertain: false,
      },
      async () => ({ observedVersion: sha("fake") }),
    ),
  );
});

test("symlinks are refused rather than hashing their targets", async (t) => {
  const { workspace } = await fixture(t);
  const target = path.join(workspace, "target.txt");
  await fs.writeFile(target, "target");
  const link = path.join(workspace, "link.txt");
  try {
    await fs.symlink(target, link);
  } catch (error) {
    if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      t.skip("Host cannot create file symlinks");
      return;
    }
    throw error;
  }
  await assert.rejects(observeSessionFile(workspace, "link.txt"), /Symbolic/);
});

test("save failure leaves complete previous rows, retry does not duplicate even after an ambiguous saved result", async (t) => {
  const { adapter } = await fixture(t);
  const observe = async () => ({ observedVersion: sha("v") });
  await appendSessionObservations(adapter, "session", "one", empty, observe);
  const filename = sessionObservationPath("session"),
    before = await adapter.readFile(filename);
  const original = adapter.writeFile.bind(adapter);
  adapter.writeFile = async () => {
    throw new Error("simulated sync save failure");
  };
  await assert.rejects(appendSessionObservations(adapter, "session", "two", empty, observe));
  assert.equal(await adapter.readFile(filename), before);
  adapter.writeFile = async (p, raw) => {
    await original(p, raw);
    throw new Error("saved but caller did not receive success");
  };
  await assert.rejects(appendSessionObservations(adapter, "session", "two", empty, observe));
  adapter.writeFile = original;
  assert.equal(
    (await appendSessionObservations(adapter, "session", "two", empty, observe)).appended,
    false,
  );
  assert.equal((await adapter.readFile(filename)).split("\n").filter(Boolean).length, 2);
});

test("a failed NodeFs atomic rename cannot expose a half row or retain temporary files", async (t) => {
  const { workspace, adapter } = await fixture(t);
  const observe = async () => ({ observedVersion: sha("v") });
  await appendSessionObservations(adapter, "session", "one", empty, observe);
  const filename = sessionObservationPath("session"),
    raw = await adapter.readFile(filename);
  // Fail at the real adapter's final publication step, after writing its temp file.
  const original = fs.rename;
  const destination = path.join(workspace, ".tent", filename);
  const failure = Object.assign(new Error("rename failed"), { code: "EIO" });
  const failPublication: typeof fs.rename = async (from, to) => {
    if (path.resolve(String(to)) === destination) throw failure;
    await original(from, to);
  };
  const mocked = t.mock.method(fs, "rename", failPublication);
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      appendSessionObservations(adapter, "session", "two", empty, observe),
      (error) => error === failure,
    );
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(await adapter.readFile(filename), raw);
  assert.deepEqual(await fs.readdir(path.join(workspace, ".tent", "temp", "observations")), [
    path.basename(filename),
  ]);
  await appendSessionObservations(adapter, "session", "two", empty, observe);
  assert.equal((await readSessionObservations(adapter)).events.length, 2);
});

test("recent/all readers retain valid facts and flag corrupt, foreign, extra-content, and truncated rows", async (t) => {
  const { adapter } = await fixture(t),
    observe = async () => ({ observedVersion: sha("v") });
  const { event } = await appendSessionObservations(adapter, "session", "one", empty, observe);
  const filename = sessionObservationPath("session");
  const bad = [
    "not JSON ERROR SECRET",
    JSON.stringify({ ...event, turnId: "extra", text: "CHAT SECRET" }),
    JSON.stringify({ ...event, sessionId: "other", turnId: "foreign" }),
    '{"schema":1',
  ];
  await adapter.writeFile(filename, JSON.stringify(event) + "\n" + bad.join("\n"));
  const result = await readSessionObservations(adapter);
  assert.equal(result.uncertain, true);
  assert.deepEqual(result.events, [event]);
  assert.equal(JSON.stringify(result.events).includes("SECRET"), false);
  const raw = await adapter.readFile(filename);
  await assert.rejects(
    appendSessionObservations(adapter, "session", "two", empty, observe),
    /repair/,
  );
  assert.equal(await adapter.readFile(filename), raw);
  adapter.readFile = async () => {
    throw new Error("filesystem secret");
  };
  assert.deepEqual(await readRecentSessionObservations(adapter), { events: [], uncertain: true });
});

test("all-reader does not silently lose old outputs beyond the recent 100-event limit", async (t) => {
  const { adapter } = await fixture(t);
  const observe = async () => ({ observedVersion: sha("v") });
  const { event } = await appendSessionObservations(adapter, "session", "one", empty, observe);
  const events = Array.from({ length: 110 }, (_, index) => ({
    ...event,
    turnId: `turn-${index}`,
    observedAt: new Date(Date.UTC(2026, 9, 4, 0, 0, index)).toISOString(),
  }));
  await adapter.writeFile(
    sessionObservationPath("session"),
    events.map((value) => JSON.stringify(value)).join("\n") + "\n",
  );
  assert.equal((await readSessionObservations(adapter)).events.length, 110);
  const recent = await readRecentSessionObservations(adapter, { limit: 100 });
  assert.equal(recent.events.length, 100);
  assert.equal(recent.events[0]!.turnId, "turn-109");
  assert.equal(recent.uncertain, false);
});
