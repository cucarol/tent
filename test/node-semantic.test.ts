import assert from "node:assert/strict";
import { test } from "node:test";
import { nodeSemanticFingerprint } from "../src/core/node-sync-record.js";
import { isCardResponseSource } from "../src/core/material.js";

test("semantic fingerprints preserve ordered source addresses and body while excluding administrative metadata", () => {
  const data = {
    id: "node-goal",
    type: "goal-requirement",
    tags: ["initial"],
    resource: "../../main.txt",
    sources: [{ resource: "../../first.txt", description: "initial" }],
  };
  const fingerprint = (patch = {}, body = "requirement\n") =>
    nodeSemanticFingerprint({ ...data, ...patch }, body, "Goal/Goal.md");
  const initial = fingerprint();
  assert.equal(
    fingerprint({
      type: "goal-direction",
      tags: ["done"],
      verified: { by: "human:cuca", at: "2026-10-06T00:00:00Z" },
      sources: [{ resource: "../../first.txt", description: "edited metadata" }],
    }),
    initial,
  );
  assert.equal(fingerprint({}, "requirement\r\n"), initial);
  assert.notEqual(fingerprint({}, "requirement!\n"), initial);
  assert.notEqual(fingerprint({ resource: "../../other.txt" }), initial);
  assert.notEqual(fingerprint({ sources: [] }), initial);
  assert.notEqual(
    fingerprint({ sources: [{ resource: "../../first.txt" }, { resource: "../../second.txt" }] }),
    fingerprint({ sources: [{ resource: "../../second.txt" }, { resource: "../../first.txt" }] }),
  );
});

test("Card response sources are excluded from semantic dependencies while Card resources remain materials", () => {
  const owner = "Goal/Output/Output.md";
  const fingerprint = (data: Record<string, unknown>) =>
    nodeSemanticFingerprint(data, "output", owner);
  assert.equal(isCardResponseSource("/cards/card-dcgvrhjj.md", owner), true);
  assert.equal(isCardResponseSource("../../cards/card-dcgvrhjj.md", owner), true);
  assert.equal(isCardResponseSource("/cards/random.md", owner), false);
  assert.equal(
    fingerprint({}),
    fingerprint({ sources: [{ resource: "/cards/card-dcgvrhjj.md" }] }),
  );
  assert.notEqual(fingerprint({}), fingerprint({ resource: "/cards/card-dcgvrhjj.md" }));
});
