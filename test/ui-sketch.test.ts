import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mergeElements, signature, versionsOf } from "../src/ui/map/annotations.js";
import { withMissing } from "../src/ui/map/excalidrawZh.js";

const locales = fileURLToPath(
  new URL("../node_modules/@excalidraw/excalidraw/dist/prod/locales", import.meta.url),
);
const pack = async (prefix: string) =>
  import(
    pathToFileURL(
      join(
        locales,
        readdirSync(locales).find((f) => f.startsWith(prefix))!,
      ),
    ).href
  ) as Promise<Record<string, unknown>>;

function untranslated(
  en: Record<string, unknown>,
  zh: Record<string, unknown> | undefined,
  path = "",
): string[] {
  return Object.entries(en).flatMap(([key, value]) => {
    const at = path ? `${path}.${key}` : key;
    if (typeof value === "object" && value !== null)
      return untranslated(
        value as Record<string, unknown>,
        zh?.[key] as Record<string, unknown> | undefined,
        at,
      );
    return zh?.[key] ? [] : [at];
  });
}

test("the sketch layer's Chinese covers every string Excalidraw shows", async () => {
  const [en, zh] = await Promise.all([pack("en-"), pack("zh-CN-")]);
  assert.ok(
    untranslated(en.default as Record<string, unknown>, zh.default as Record<string, unknown>)
      .length > 0,
    "upstream still misses strings",
  );
  assert.deepEqual(untranslated(en.default as Record<string, unknown>, withMissing(zh)), []);
});

test("an upstream translation wins over the fill-in", async () => {
  const merged = withMissing({ default: {}, labels: { arrowtypes: "上游的译法" }, hints: {} });
  assert.equal((merged.labels as Record<string, string>).arrowtypes, "上游的译法");
  assert.equal((merged.hints as Record<string, string>).dismissSearch, "按 Esc 关闭搜索");
  assert.equal(merged.default, undefined);
});

test("two pages' annotations merge by element, keeping each side's own changes", () => {
  const el = (id: string, version: number) => ({ id, version });
  const base = versionsOf([
    el("kept", 1),
    el("mine-edit", 1),
    el("their-edit", 1),
    el("mine-gone", 1),
    el("their-gone", 1),
    el("both", 1),
  ]);
  const mine = [
    el("kept", 1),
    el("mine-edit", 2),
    el("their-edit", 1),
    el("their-gone", 1),
    el("both", 3),
    el("mine-new", 1),
  ];
  const theirs = [
    el("kept", 1),
    el("mine-edit", 1),
    el("their-edit", 2),
    el("mine-gone", 1),
    el("both", 2),
    el("their-new", 1),
  ];
  assert.deepEqual(
    mergeElements(base, mine, theirs).map((e) => `${e.id}@${e.version}`),
    ["kept@1", "mine-edit@2", "their-edit@2", "both@3", "mine-new@1", "their-new@1"],
  );
  // A mark edited on one side survives its removal on the other.
  assert.deepEqual(
    mergeElements(base, [el("mine-gone", 2)], []).map((e) => e.id),
    ["mine-gone"],
  );
  assert.notEqual(signature([el("a", 1)]), signature([el("a", 2)]));
});
