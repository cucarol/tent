import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as turn } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { api, ApiError } from "../src/ui/data/api.js";
import { canvasBase, emptyCanvas, type CanvasInitial } from "../src/ui/map/canvas.js";
import { SAVE_AFTER, useCanvas, type CanvasStore } from "../src/ui/map/useCanvas.js";
import {
  CanvasError,
  readCanvasDocument,
  writeCanvasDocument,
} from "../src/core/workspace/canvas.js";
import { contentEtag } from "../src/core/base/etag.js";
import { initializeFixtureWorkspace, testScratchRoot } from "./scratch.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";

// The production hook runs through React's client renderer and effects, rendering
// null. No browser or fake copy of the hook's state/save algorithm is involved.
async function hook(initial: CanvasInitial) {
  class Element extends EventTarget {
    nodeType = 1;
    nodeName = "DIV";
    tagName = "DIV";
    namespaceURI = "http://www.w3.org/1999/xhtml";
    firstChild = null;
    textContent = "";
    style = {};
    ownerDocument: unknown;
    setAttribute() {}
  }
  const body = new Element();
  body.nodeName = body.tagName = "BODY";
  const document = Object.assign(new EventTarget(), {
    nodeType: 9,
    body,
    activeElement: body,
    visibilityState: "visible",
    documentElement: { nodeName: "HTML", namespaceURI: "http://www.w3.org/1999/xhtml" },
    createElement: () => new Element(),
  });
  const window = Object.assign(new EventTarget(), {
    document,
    HTMLElement: Element,
    HTMLIFrameElement: class {},
  });
  Object.assign(document, { defaultView: window });
  body.ownerDocument = document;
  const container = new Element();
  container.ownerDocument = document;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window, document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  let store!: CanvasStore;
  let revision = "r1";
  const notices: string[] = [];
  function Probe() {
    store = useCanvas("ws-conflict", revision, (message) => notices.push(message), initial);
    return null;
  }
  const root = createRoot(container as unknown as HTMLElement);
  await act(async () => root.render(createElement(Probe)));
  let mounted = true;
  return {
    get store() {
      return store;
    },
    document,
    window,
    notices,
    async change(action: (store: CanvasStore) => void) {
      await act(async () => action(store));
    },
    async refresh() {
      revision += "+";
      await act(async () => {
        root.render(createElement(Probe));
        await turn();
      });
    },
    async unmount() {
      if (mounted) {
        mounted = false;
        await act(async () => root.unmount());
      }
    },
    restore() {
      for (const [key, descriptor] of saved)
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    },
  };
}

const badA = '{"version":2,"old":"A"}';
const badB = '{"version":2,"old":"a different saved view"}';
const note = (id: string, text = id) => ({
  id,
  kind: "text" as const,
  at: [0, 0] as [number, number],
  text,
});

async function scenario(
  t: TestContext,
  initialRaw: string,
  replacement: string | null,
  replaceOnSave = true,
) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "canvas-conflict-"));
  await initializeFixtureWorkspace(root);
  const adapter = openTestFs(path.join(root, ".tent"), "ui");
  await adapter.writeFile("canvas.json", initialRaw);
  let initial: CanvasInitial;
  try {
    initial = canvasBase(await readCanvasDocument(adapter));
  } catch (error) {
    assert.ok(error instanceof CanvasError && error.details);
    initial = canvasBase(error.details.current);
  }
  const requests: { etag: string | null; leaving: boolean }[] = [];
  const active = new Set<Promise<unknown>>();
  const asApi = (error: unknown): never => {
    if (error instanceof CanvasError)
      throw new ApiError(
        error.code === "ETAG_CONFLICT" ? 409 : 422,
        error.code,
        error.message,
        error.details,
      );
    throw error;
  };
  t.mock.method(api, "canvas", async () => {
    try {
      return await readCanvasDocument(adapter);
    } catch (error) {
      return asApi(error);
    }
  });
  t.mock.method(
    api,
    "saveCanvas",
    (etag: string | null, canvas: unknown, leaving: boolean = false) => {
      requests.push({ etag, leaving });
      const attempt = requests.length;
      const operation = (async () => {
        if (attempt === 1 && replaceOnSave) {
          if (replacement === null) await adapter.remove("canvas.json");
          else await adapter.writeFile("canvas.json", replacement);
        }
        try {
          return await writeCanvasDocument(adapter, { baseEtag: etag, canvas });
        } catch (error) {
          return asApi(error);
        }
      })();
      active.add(operation);
      operation.then(
        () => active.delete(operation),
        () => active.delete(operation),
      );
      return operation;
    },
  );
  const ui = await hook(initial);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const settle = async () => {
    for (let i = 0; i < 12; i++) {
      await act(async () => {
        await Promise.allSettled([...active]);
        await turn();
      });
      if (!active.size) return;
    }
    assert.fail("canvas save loop did not settle");
  };
  const advance = async () => {
    await act(async () => t.mock.timers.tick(SAVE_AFTER * 10));
    await settle();
  };
  t.after(async () => {
    try {
      await ui.unmount();
      await settle();
    } finally {
      ui.restore();
      await removeTestFixture(root, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 200,
      });
    }
  });
  const refresh = async () => {
    let loaded!: () => void;
    const observed = new Promise<void>((resolve) => {
      loaded = resolve;
    });
    const read = api.canvas;
    const wrapped = t.mock.method(api, "canvas", async () => {
      try {
        return await read();
      } finally {
        loaded();
      }
    });
    try {
      await ui.refresh();
      await act(async () => {
        await observed;
        await turn();
      });
      await settle();
    } finally {
      wrapped.mock.restore();
    }
  };
  return { adapter, ui, requests, settle, advance, refresh };
}

test("an automatic revision read preserves new unreadable bytes until a later real edit", async (t) => {
  const { adapter, ui, requests, advance, settle, refresh } = await scenario(t, badA, badB, false);
  await ui.change((canvas) => canvas.arrange({ folds: { "node-local": "open" } }));
  await adapter.writeFile("canvas.json", badB);
  await refresh();
  await advance();
  assert.equal(requests.length, 0, "a read cannot consent to replacing B with old pending edits");
  assert.equal(await adapter.readFile("canvas.json"), badB);
  assert.deepEqual(ui.store.open, ["node-local"]);
  await ui.change((canvas) => {
    canvas.keep(new Map([["projection", note("projection")]]));
    canvas.arrange({ folds: { "node-automatic": "open" } }, false);
    canvas.arrange({ folds: { "node-local": "open" } });
  });
  await refresh();
  await act(async () => {
    ui.window.dispatchEvent(new Event("pagehide"));
    ui.document.visibilityState = "hidden";
    ui.document.dispatchEvent(new Event("visibilitychange"));
  });
  await settle();
  await advance();
  assert.equal(requests.length, 0);
  assert.equal(await adapter.readFile("canvas.json"), badB);
  await ui.change((canvas) => canvas.arrange({ folds: { "node-later": "shut" } }));
  await advance();
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.etag, contentEtag(badB));
  const saved = (await readCanvasDocument(adapter)).canvas!;
  assert.ok(saved.open.includes("node-local"), "the paused edit survives until saving resumes");
  assert.ok(saved.shut.includes("node-later"));
  assert.equal(ui.store.unreadable, false);
});

test("opaque debounce conflict preserves edits and B through automatic events, then a genuine fold resumes", async (t) => {
  const { adapter, ui, requests, advance, settle } = await scenario(t, badA, badB);
  await ui.change((canvas) => canvas.arrange({ folds: { "node-local": "open" } }));
  await advance();
  assert.equal(requests.length, 1, "opaque B cannot become an automatic retry base");
  assert.equal(await adapter.readFile("canvas.json"), badB);
  assert.deepEqual(ui.store.open, ["node-local"]);
  assert.equal(ui.store.unreadable, true);
  await ui.refresh();
  await settle();
  await ui.change((canvas) => {
    canvas.keep(new Map([["projection", note("projection")]]));
    canvas.arrange({ folds: { "node-automatic": "open" } }, false);
    canvas.arrange({ folds: { "node-local": "open" } }); // no change is not another edit
  });
  await act(async () => {
    ui.window.dispatchEvent(new Event("pagehide"));
    ui.document.visibilityState = "hidden";
    ui.document.dispatchEvent(new Event("visibilitychange"));
  });
  await advance();
  assert.equal(requests.length, 1);
  assert.equal(await adapter.readFile("canvas.json"), badB);
  await ui.change((canvas) => canvas.arrange({ folds: { "node-local": "shut" } }));
  await advance();
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.etag, contentEtag(badB));
  assert.deepEqual((await readCanvasDocument(adapter)).canvas?.shut, ["node-local"]);
  assert.equal(ui.store.unreadable, false);
});

test("opaque pagehide conflict stops its loop and pending debounce until another drawing edit", async (t) => {
  const { adapter, ui, requests, advance, settle } = await scenario(t, badA, badB);
  await ui.change((canvas) => canvas.commit([note("mine")]));
  await act(async () => ui.window.dispatchEvent(new Event("pagehide")));
  await settle();
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.leaving, true);
  assert.deepEqual(
    ui.store.ink.map((ink) => ink.id),
    ["mine"],
  );
  assert.equal(ui.store.unreadable, true);
  await advance();
  assert.equal(requests.length, 1);
  assert.equal(await adapter.readFile("canvas.json"), badB);
  await ui.change((canvas) => canvas.commit([note("mine", "explicit second edit")]));
  await advance();
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.etag, contentEtag(badB));
  assert.equal(
    (await readCanvasDocument(adapter)).canvas?.drawings[0]?.text,
    "explicit second edit",
  );
});

test("unmount cleanup does not flush a paused opaque conflict", async (t) => {
  const { adapter, ui, requests, advance, settle } = await scenario(t, badA, badB);
  await ui.change((canvas) => canvas.arrange({ folds: { "node-local": "open" } }));
  await advance();
  assert.equal(requests.length, 1);
  await ui.unmount();
  await settle();
  assert.equal(requests.length, 1);
  assert.equal(await adapter.readFile("canvas.json"), badB);
});

for (const [kind, replacement] of [
  ["readable v3", JSON.stringify({ ...emptyCanvas(), drawings: [note("theirs")] }) + "\n"],
  ["missing", null],
] as const) {
  test(`${kind} revision reads still merge and save pending local drawings`, async (t) => {
    const { adapter, ui, requests, advance, refresh } = await scenario(t, badA, replacement, false);
    await ui.change((canvas) => canvas.commit([note("mine")]));
    if (replacement === null) await adapter.remove("canvas.json");
    else await adapter.writeFile("canvas.json", replacement);
    await refresh();
    await advance();
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.etag, replacement === null ? null : contentEtag(replacement));
    const ids = (await readCanvasDocument(adapter)).canvas!.drawings.map((drawing) => drawing.id);
    assert.deepEqual(ids, kind === "readable v3" ? ["theirs", "mine"] : ["mine"]);
    assert.equal(ui.store.unreadable, false);
  });

  test(`${kind} current still merges and automatically retries a normal canvas conflict`, async (t) => {
    const { adapter, ui, requests, advance } = await scenario(
      t,
      JSON.stringify(emptyCanvas()) + "\n",
      replacement,
    );
    await ui.change((canvas) => canvas.commit([note("mine")]));
    await advance();
    assert.equal(requests.length, 2);
    const ids = (await readCanvasDocument(adapter)).canvas!.drawings.map((drawing) => drawing.id);
    assert.deepEqual(ids, kind === "readable v3" ? ["theirs", "mine"] : ["mine"]);
    assert.equal(ui.store.unreadable, false);
  });
}
