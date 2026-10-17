import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { fitZoom, watchSpace } from "../src/ui/map/pointer.js";
import { continueDrag, setDropHandler } from "../src/ui/shell/drag.js";

test("a fit never zooms past 100%, whatever the caller allows", () => {
  // A small lens view in a big window would fit at 300%.
  assert.equal(fitZoom(600, 300, { w: 1800, h: 1000 }, 1.1, 0.4), 1);
  assert.equal(fitZoom(600, 300, { w: 1800, h: 1000 }, 0.9, 0.4), 0.9);
  // Too big to fit holds at the floor.
  assert.equal(fitZoom(18000, 10000, { w: 1800, h: 1000 }, 1, 0.4), 0.4);
  assert.equal(fitZoom(2400, 1000, { w: 1800, h: 1000 }, 1, 0.4), 0.75);
});

test("Space lets go when the window loses focus, even without its key going up", () => {
  const win = new EventTarget();
  const space = watchSpace(win as unknown as Window);
  const key = (type: string, k = " ") =>
    win.dispatchEvent(Object.assign(new Event(type), { key: k }));
  key("keydown");
  assert.equal(space.held(), true);
  key("keyup", "a");
  assert.equal(space.held(), true);
  win.dispatchEvent(new Event("blur"));
  assert.equal(space.held(), false);
  key("keydown");
  key("keyup");
  assert.equal(space.held(), false);
  space.stop();
  key("keydown");
  assert.equal(space.held(), false);
});

function page(t: TestContext, under: string | null) {
  const win = new EventTarget();
  const lane = {
    getAttribute: () => under,
    hasAttribute: () => false,
    closest: () => (under ? lane : null),
    parentElement: null,
  };
  const doc = Object.assign(new EventTarget(), {
    body: { classList: { add() {}, remove() {} } },
    elementFromPoint: () => (under ? lane : null),
    getSelection: () => null,
  });
  const restore: (() => void)[] = [];
  for (const [name, value] of [
    ["window", Object.assign(win, { getSelection: () => null })],
    ["document", doc],
  ] as const) {
    const was = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    restore.push(() =>
      was ? Object.defineProperty(globalThis, name, was) : Reflect.deleteProperty(globalThis, name),
    );
  }
  t.after(() => restore.forEach((r) => r()));
  return win;
}

test("a card carried off the map onto a lane drops there when let go at once", async (t) => {
  const win = page(t, "lane:");
  const dropped: string[] = [];
  setDropHandler({
    accepts: () => true,
    drop: (item, target) => dropped.push(`${item.id}@${target}`),
  });
  continueDrag({ kind: "node", id: "node-aaaaaa" }, { x: 40, y: 500 });
  win.dispatchEvent(new Event("pointerup"));
  assert.deepEqual(dropped, ["node-aaaaaa@lane:"]);
  // The drop's click guard comes off a tick later, before the page is put back.
  await new Promise((r) => setTimeout(r, 0));
});

test("a card carried off the map over nothing that takes it drops nowhere", async (t) => {
  const win = page(t, "lane:role-x");
  const dropped: string[] = [];
  setDropHandler({
    accepts: () => false,
    drop: (item, target) => dropped.push(`${item.id}@${target}`),
  });
  continueDrag({ kind: "node", id: "node-aaaaaa" }, { x: 40, y: 500 });
  win.dispatchEvent(new Event("pointerup"));
  assert.deepEqual(dropped, []);
  // The drop's click guard comes off a tick later, before the page is put back.
  await new Promise((r) => setTimeout(r, 0));
});
