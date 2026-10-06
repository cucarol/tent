import assert from "node:assert/strict";
import test from "node:test";
import type { FsAdapter } from "../src/core/adapter.js";
import { shareInFlightReads } from "../src/ui-server/shared-reads.js";

test("overlapping equal reads share work, while a later query reads changed content", async () => {
  let calls = 0;
  let complete!: (value: string) => void;
  const fs = shareInFlightReads({
    readFile: () => {
      calls++;
      return new Promise<string>((resolve) => {
        complete = resolve;
      });
    },
  } as unknown as FsAdapter);
  const first = fs.readFile("goal.md");
  const same = fs.readFile("goal.md");
  assert.equal(calls, 1);
  complete("old");
  assert.deepEqual(await Promise.all([first, same]), ["old", "old"]);
  const later = fs.readFile("goal.md");
  assert.equal(calls, 2);
  complete("new");
  assert.equal(await later, "new");
});

test("paths and read methods remain independent, and failed reads can retry", async () => {
  const calls: string[] = [];
  const pending: { resolve(value: unknown): void; reject(error: Error): void }[] = [];
  const read = (name: string, file: string) => {
    calls.push(`${name}:${file}`);
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  };
  const fs = shareInFlightReads({
    readFile: (file: string) => read("text", file),
    readBinary: (file: string) => read("binary", file),
  } as FsAdapter);
  const a = fs.readFile("a");
  const aBytes = fs.readBinary("a");
  const b = fs.readFile("b");
  const aAgain = fs.readFile("a");
  const outcomes = Promise.allSettled([a, aBytes, b, aAgain]);
  assert.deepEqual(calls, ["text:a", "binary:a", "text:b"]);
  pending[0]!.reject(new Error("changed while reading"));
  pending[1]!.resolve(new Uint8Array([1]));
  pending[2]!.resolve("b");
  assert.deepEqual(
    (await outcomes).map((result) => result.status),
    ["rejected", "fulfilled", "fulfilled", "rejected"],
  );
  const retry = fs.readFile("a");
  assert.equal(calls.length, 4);
  pending[3]!.resolve("a");
  assert.equal(await retry, "a");
});

test("unshared adapter methods preserve their receiver and perform each call", async () => {
  const calls: string[] = [];
  const adapter = {
    history: { identity: "history" },
    async observeMaterial(resource: string) {
      assert.equal(this, adapter);
      calls.push(resource);
      return { observedVersion: "fresh" };
    },
  };
  const fs = shareInFlightReads(adapter as unknown as FsAdapter);
  assert.equal(fs.history, adapter.history);
  await Promise.all([fs.observeMaterial!("a", "goal.md"), fs.observeMaterial!("a", "goal.md")]);
  assert.deepEqual(calls, ["a", "a"]);
});
