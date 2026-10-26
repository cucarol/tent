import assert from "node:assert/strict";
import { test } from "node:test";
import { materialFact, materialFacts } from "../src/ui/data/materials.js";
import { heldSection } from "../src/ui/data/node-details.js";
import { setLang, t } from "../src/ui/i18n.js";

test("a material reads as changed, deleted or unreadable, and says nothing about Tent's own records", () => {
  const at = (state: "current" | "changed" | "unavailable" | "unanchored", reason?: string) =>
    materialFact({ resource: "../a.md", state, ...(reason ? { reason } : {}) });
  assert.equal(at("current"), null);
  assert.equal(at("unanchored"), null);
  assert.equal(at("changed"), "changed");
  assert.equal(
    at("unavailable", "ENOENT: no such file or directory, lstat 'C:\\w\\a.md'"),
    "deleted",
  );
  assert.equal(
    at("unavailable", "Repository material was deleted in the main checkout: src/a.ts"),
    "deleted",
  );
  assert.equal(
    at("unavailable", "Remote material version is unknown; no network request was made"),
    "unreadable",
  );
  assert.equal(at("unavailable", "Node record has no retained baseline for this material"), null);
  assert.deepEqual(
    [
      ...materialFacts([
        { resource: "a", state: "changed" },
        { resource: "b", state: "current" },
      ]),
    ],
    [["a", "changed"]],
  );
});

test("the page states material facts without the words behind or ahead", () => {
  for (const lang of ["zh", "en"] as const) {
    setLang(lang, false);
    for (const said of Object.values(t.rel.materialFact))
      assert.doesNotMatch(said, /落后|领先|behind|ahead/i);
  }
  setLang("zh", false);
  assert.equal(t.rel.materialFact.changed, "在这条写下之后改过");
});

test("a Node keeps its material facts while a newer revision is compared, and another Node does not", () => {
  const held: Parameters<typeof heldSection<number>>[0] = { current: null };
  const retry = () => {};
  const read = (data: number | null) => ({ data, error: null, retry });
  assert.equal(heldSection(held, "node-a", read(null)).data, null);
  assert.equal(heldSection(held, "node-a", read(1)).data, 1);
  assert.equal(heldSection(held, "node-a", read(null)).data, 1);
  assert.equal(heldSection(held, "node-b", read(null)).data, null);
  assert.equal(heldSection(held, "node-b", read(2)).data, 2);
});
