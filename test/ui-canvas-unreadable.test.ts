import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CANVAS_LIMIT,
  CanvasError,
  readCanvasDocument,
  writeCanvasDocument,
} from "../src/core/workspace/canvas.js";
import { api, ApiError } from "../src/ui/data/api.js";
import { loadCanvas } from "../src/ui/map/canvas-api.js";
import { emptyCanvas, foldEdit, hasPending, withPending } from "../src/ui/map/canvas.js";
import { CanvasNotice } from "../src/ui/map/CanvasNotice.js";
import { arrange } from "../src/ui/map/arrange.js";
import type { SnapshotNode } from "../src/ui/data/types.js";
import { setLang } from "../src/ui/i18n.js";
import { initializeFixtureWorkspace, testScratchRoot } from "./scratch.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";

async function fixture(t: TestContext, raw: string) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "canvas-unreadable-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await initializeFixtureWorkspace(root);
  const adapter = openTestFs(path.join(root, ".tent"), "ui");
  await adapter.writeFile("canvas.json", raw);
  t.mock.method(api, "canvas", async () => {
    try {
      return await readCanvasDocument(adapter);
    } catch (error) {
      if (!(error instanceof CanvasError)) throw error;
      throw new ApiError(422, error.code, error.message, error.details);
    }
  });
  return adapter;
}

for (const [kind, original] of [
  [
    "v2",
    '{"version":2,"positions":{"node-a":[999,999]},"drawings":[{"id":"old","kind":"text","text":"old drawing"}]}',
  ],
  ["bad JSON", "{broken saved view"],
  ["v1", '{"version":1,"forms":{},"positions":{},"drawings":[]}'],
  ["oversized", " ".repeat(CANVAS_LIMIT + 1)],
] as const) {
  test(`${kind} canvas opens a default layout and notice without writing; one user fold saves v3`, async (t) => {
    const adapter = await fixture(t, original);
    const head = await adapter.history.currentCommit();
    const initial = await loadCanvas();
    assert.ok("file" in initial);
    assert.equal(initial.unreadable, true);
    assert.deepEqual(
      initial.file,
      emptyCanvas(),
      "no old folds, positions or drawings are interpreted",
    );
    setLang("zh", false);
    t.after(() => setLang("zh", false));
    const notice = renderToStaticMarkup(createElement(CanvasNotice, { onNotice() {} }));
    assert.match(notice, /role="status"/);
    assert.match(notice, /保存的视图没读，已按默认显示/);
    assert.match(notice, /复制路径/);
    const kids = (id: string | null) =>
      (id === null ? ["node-a"] : id === "node-a" ? ["node-b"] : []).map(
        (id) => ({ id }) as SnapshotNode,
      );
    const layout = arrange({ kidsOf: kids, closed: new Set(initial.file.shut) });
    assert.ok(layout.placed.has("node-a") && layout.placed.has("node-b"));
    const automatic = foldEdit(initial.file, { "node-a": "open" }, true, false);
    assert.equal(automatic.persist, false, "layout/deep-link reveals cannot replace the file");
    assert.equal(hasPending(foldEdit(initial.file, {}, true, true).change), false);
    assert.equal(await adapter.readFile("canvas.json"), original);
    assert.equal(await adapter.history.currentCommit(), head);
    const edit = foldEdit(initial.file, { "node-a": "open" }, true, true);
    assert.equal(edit.persist, true);
    const saved = withPending(initial.file, edit.change);
    await writeCanvasDocument(adapter, { baseEtag: initial.etag, canvas: saved });
    assert.deepEqual((await readCanvasDocument(adapter)).canvas, {
      ...emptyCanvas(),
      open: ["node-a"],
    });
    const reopened = await loadCanvas();
    assert.ok("file" in reopened);
    assert.equal(reopened.unreadable, undefined);
    assert.equal(
      foldEdit(reopened.file, { "node-a": "shut" }, false, true).persist,
      false,
      "readable v3 folds retain their prior memory-only rule",
    );
  });
}

test("transport, permission and malformed error metadata never masquerade as a default editable canvas", async (t) => {
  for (const error of [
    new ApiError(0, "OFFLINE", "offline"),
    new ApiError(401, "NO_TOKEN", "no token"),
    new ApiError(500, "EACCES", "permission denied"),
    new ApiError(422, "INVALID_INPUT", "missing ETag"),
    new ApiError(422, "INVALID_INPUT", "legacy contents", {
      current: { etag: "x", canvas: { version: 2 } },
    }),
  ]) {
    const mock = t.mock.method(api, "canvas", async () => {
      throw error;
    });
    const initial = await loadCanvas();
    assert.ok("error" in initial);
    mock.mock.restore();
  }
});
