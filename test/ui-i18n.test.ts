import assert from "node:assert/strict";
import { test } from "node:test";
import { setLang, t } from "../src/ui/i18n.js";
import { ago, pathTail } from "../src/ui/util.js";

const now = Date.parse("2026-09-29T12:00:00Z");

test("switching language switches every message, dates included", () => {
  setLang("en", false);
  assert.equal(t.code, "en");
  assert.equal(ago("2026-09-29T11:15:00Z", now), "45 min ago");
  assert.equal(ago("2026-09-28T12:00:00Z", now), "1 day ago");
  assert.equal(ago("2026-09-26T12:00:00Z", now), "3 days ago");
  assert.equal(t.card.contextOnly(1), "Context only · 1 source");
  assert.equal(t.map.children(2), "2 children");
  assert.equal(t.cardProgress["received-no-output"], "Received, no output yet");
  assert.equal(t.cardProgress["has-output"], "Has output");
  assert.equal(t.work.saved, "Saved in this browser");

  setLang("zh", false);
  assert.equal(t.code, "zh-CN");
  assert.equal(ago("2026-09-26T12:00:00Z", now), "3 天前");
  assert.equal(t.card.contextOnly(1), "仅附上下文 · 1 个来源");
});

test("a commit summary names two Nodes and counts the rest, in either language", () => {
  setLang("zh", false);
  assert.equal(t.map.commitSummary(1, 2, ["甲", "乙", "丙"]), "新建 1 · 修改 2：甲、乙 等 3 个");
  assert.equal(t.map.commitSummary(0, 1, ["甲"]), "修改 1：甲");
  setLang("en", false);
  assert.equal(t.map.commitSummary(1, 2, ["A", "B", "C"]), "1 added · 2 changed: A, B and 1 more");
  assert.equal(t.map.commitSummary(0, 1, ["A"]), "1 changed: A");
  setLang("zh", false);
});

test("the switch always names the other language", () => {
  setLang("zh", false);
  assert.deepEqual([t.switchTo, t.switchLabel], ["en", "EN"]);
  setLang("en", false);
  assert.deepEqual([t.switchTo, t.switchLabel], ["zh", "中"]);
  setLang("zh", false);
});

test("a long workspace path keeps the folders at its end", () => {
  assert.equal(pathTail(String.raw`C:\work\app`), String.raw`C:\work\app`);
  assert.equal(
    pathTail(String.raw`C:\Users\dev\code\app\.claude\worktrees\web-ui\.scratch\alpha`),
    String.raw`…\worktrees\web-ui\.scratch\alpha`,
  );
  assert.equal(
    pathTail("/Users/dev/Documents/projects/clients/2026/very-long-name"),
    "…/projects/clients/2026/very-long-name",
  );
  assert.equal(pathTail("/a/" + "x".repeat(50)), "…/" + "x".repeat(50));
});

test("behind and ahead reasons read by kind, not as file names", () => {
  setLang("zh", false);
  assert.equal(
    t.map.behindWhy([
      "Goal node-ab12cd: Material changed: ../../docs/SPEC.md#Reception%20and%20outputs",
      "Material changed: ../src/a.ts",
    ]),
    "落后：SPEC.md#Reception and outputs、a.ts 改过",
  );
  assert.equal(
    t.map.behindWhy(["Content is stale on or after 2026-10-01"]),
    "落后：内容已在 2026-10-01 到期",
  );
  assert.equal(
    t.map.behindWhy([
      "Goal node-ab12cd: Output has no retained baseline for this ancestor goal: /A/A.md",
      "Goal node-ab12cd: Output has no retained baseline for this goal material: ../README.md",
      "Goal node-ab12cd: Remote material version is unknown; no network request was made: https://example.com/x",
    ]),
    "落后：2 份材料还没有基线，复核后确认一次；1 份材料无法核对",
  );
  assert.equal(
    t.map.behindWhy([
      "Repository material was deleted in the main checkout: src/shared.ts: ../../src/shared.ts",
    ]),
    "落后：shared.ts 已删除",
  );
  assert.equal(t.map.aheadWhy("3 小时前", "empty"), "领先（3 小时前起）：还没有产出");
  assert.equal(t.map.aheadWhy(null, "behind"), "领先：产出还没跟上");
  assert.equal(t.now.goalChanged("3 小时前", 2), "领先（3 小时前起）：2 个产出要按新要求复核");

  setLang("en", false);
  assert.equal(
    t.map.behindWhy(["Material changed: a.md", "Material changed: b.md", "Material changed: c.md"]),
    "Behind: a.md, b.md and 1 more changed",
  );
  assert.equal(
    t.map.behindWhy(["Content is stale on or after 2026-10-01"]),
    "Behind: content expired on 2026-10-01",
  );
  assert.equal(
    t.map.aheadWhy("3 hours ago", "behind"),
    "Ahead since 3 hours ago: outputs have not caught up",
  );
  setLang("zh", false);
});
