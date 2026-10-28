import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  clearRect,
  fitViewport,
  fitZoom,
  wheelViewport,
  uncoverViewport,
} from "../src/ui/map/pointer.js";
import {
  beginDrag,
  distanceToBox,
  edgeScroll,
  mapDropAllowed,
  setDropHandler,
} from "../src/ui/shell/drag.js";
import { nearest } from "../src/ui/map/geometry.js";
import type { Layout, Placed } from "../src/ui/map/layout.js";

test("opening a dock preserves readable zoom and only pans an obscured selected topic", () => {
  const room = { x: 12, y: 12, w: 712, h: 600 };
  const dock = { x: 420, y: 12, w: 304, h: 110 };
  const view = { x: 300, y: 180, zoom: 0.8 };
  const clear = { x: -100, y: 50, w: 120, h: 30 };
  assert.deepEqual(uncoverViewport(view, clear, room, [dock]), view);
  const obscured = { x: 200, y: -180, w: 100, h: 30 };
  const next = uncoverViewport(view, obscured, room, [dock]);
  assert.equal(next.zoom, view.zoom);
  assert.equal(next.x, view.x);
  assert.equal(next.y - view.y, 94); // Below the Dock plus eight px, no single-Node refit.
  assert.deepEqual(uncoverViewport(next, obscured, room, [dock]), next);
});

test("a fit never zooms past 100%, whatever the caller allows", () => {
  // A small lens view in a big window would fit at 300%.
  assert.equal(fitZoom(600, 300, { w: 1800, h: 1000 }, 1.1, 0.4), 1);
  assert.equal(fitZoom(600, 300, { w: 1800, h: 1000 }, 0.9, 0.4), 0.9);
  // Too big to fit holds at the floor.
  assert.equal(fitZoom(18000, 10000, { w: 1800, h: 1000 }, 1, 0.4), 0.4);
  assert.equal(fitZoom(2400, 1000, { w: 1800, h: 1000 }, 1, 0.4), 0.75);
});

test("a first view centres the visible bounds of an asymmetric saved outline", () => {
  const room = { x: 48, y: 48, w: 648, h: 588 };
  const bounds = { x: -340, y: -120, w: 760, h: 300 };
  const view = fitViewport(bounds, room, 1, 0.8);
  assert.ok(view.zoom >= 0.8);
  const left = bounds.x * view.zoom + view.x;
  const right = (bounds.x + bounds.w) * view.zoom + view.x;
  assert.ok(left >= room.x - 0.001);
  assert.ok(right <= room.x + room.w + 0.001);
  assert.ok(Math.abs(left - room.x - (room.x + room.w - right)) < 0.001);
  assert.equal((bounds.y + bounds.h / 2) * view.zoom + view.y, room.y + room.h / 2);
});

test("a fit leaves the dock clear and chooses below it when a wide outline fits there better", () => {
  const room = { x: 48, y: 48, w: 1056, h: 652 };
  const dock = { x: 800, y: 48, w: 304, h: 360 };
  const compact = clearRect(room, [dock], { w: 700, h: 500 });
  assert.deepEqual(compact, { x: 48, y: 48, w: 752, h: 652 });
  const wide = clearRect(room, [dock], { w: 1000, h: 220 });
  assert.deepEqual(wide, { x: 48, y: 408, w: 1056, h: 292 });
  const view = fitViewport({ x: -400, y: -90, w: 1000, h: 220 }, wide, 1, 0.04);
  const painted = { x: -400 * view.zoom + view.x, y: -90 * view.zoom + view.y };
  assert.ok(painted.y >= dock.y + dock.h);
  assert.ok(painted.x >= room.x && painted.x + 1000 * view.zoom <= room.x + room.w);
});

test("overlapping panels leave one continuous clear rectangle, independent of panel order", () => {
  const room = { x: 0, y: 0, w: 800, h: 600 };
  const panels = [
    { x: 500, y: -10, w: 350, h: 300 },
    { x: 550, y: 250, w: 300, h: 200 },
    { x: 200, y: 550, w: 400, h: 100 },
  ];
  const found = clearRect(room, panels, { w: 450, h: 500 });
  assert.deepEqual(found, { x: 0, y: 0, w: 500, h: 550 });
  assert.deepEqual(clearRect(room, [...panels].reverse(), { w: 450, h: 500 }), found);
  assert.equal(clearRect(room, [], { w: 450, h: 500 }), room);
});

test("Ctrl with the wheel and a pinch zoom about the pointer, one 10% step a notch", () => {
  const view = { x: 240, y: 160, zoom: 0.8 };
  const at = { x: 580, y: 390 };
  const limits = { min: 0.04, max: 4 };
  const wheel = (
    deltaY: number,
    keys: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean },
  ) =>
    wheelViewport(
      view,
      at,
      { deltaX: 0, deltaY, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, ...keys },
      limits,
    );
  for (const [deltaY, keys] of [
    [120, { ctrlKey: true }],
    [-100, { metaKey: true }],
    [-3, { ctrlKey: true }],
    [-10000, { ctrlKey: true }],
  ] as const) {
    const next = wheel(deltaY, keys);
    assert.ok(next.zoom >= limits.min && next.zoom <= limits.max);
    assert.ok(Math.abs((at.x - view.x) / view.zoom - (at.x - next.x) / next.zoom) < 0.001);
    assert.ok(Math.abs((at.y - view.y) / view.zoom - (at.y - next.y) / next.zoom) < 0.001);
  }
  // One notch is one step, not a jump: a Ctrl-wheel of 100px once zoomed 2.7 times.
  assert.ok(Math.abs(wheel(100, { ctrlKey: true }).zoom - 0.8 / 1.1) < 1e-9);
  assert.ok(Math.abs(wheel(-10000, { ctrlKey: true }).zoom - 0.8 * 1.1 ** 1.5) < 1e-9);
  // Without Ctrl the wheel moves the map, sideways with Shift; two fingers move it both ways.
  assert.deepEqual(wheel(120, {}), { ...view, y: 40 });
  assert.deepEqual(wheel(120, { shiftKey: true }), { ...view, x: 120 });
  assert.deepEqual(
    wheelViewport(
      view,
      at,
      { deltaX: 12, deltaY: 24, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false },
      limits,
    ),
    { ...view, x: 228, y: 136 },
  );
});

test("direction keys compare painted topic centres, including names of different lengths", () => {
  const from: Placed = { id: "from", x: 0, y: 0, w: 100, h: 30 };
  const left: Placed = { id: "left", x: -180, y: 0, w: 80, h: 30 };
  const wide: Placed = { id: "wide", x: -20, y: 0, w: 400, h: 30 };
  const view: Layout = { placed: new Map([from, left, wide].map((p) => [p.id, p])), labels: [] };
  assert.equal(
    nearest(view, from, [-1, 0], () => true),
    "left",
  );
  assert.equal(
    nearest(view, from, [1, 0], () => true),
    "wide",
  );
});

// A small DOM fixture exercises the real pointer owner without a browser or map renderer.
class Element extends EventTarget {
  dataset: Record<string, string> = {};
  style = { setProperty() {} } as unknown as CSSStyleDeclaration;
  classes = new Set<string>();
  classList = {
    add: (...names: string[]) => names.forEach((n) => this.classes.add(n)),
    remove: (...names: string[]) => names.forEach((n) => this.classes.delete(n)),
    contains: (name: string) => this.classes.has(name),
  };
  children: Element[] = [];
  parent: Element | null = null;
  textContent = "";
  className = "";
  offsetWidth = 100;
  offsetHeight = 30;
  scrollTop = 0;
  captured: number | null = null;
  constructor(public box = { left: 10, top: 20, width: 100, height: 30 }) {
    super();
  }
  getBoundingClientRect() {
    return {
      ...this.box,
      right: this.box.left + this.box.width,
      bottom: this.box.top + this.box.height,
    } as DOMRect;
  }
  setPointerCapture(id: number) {
    this.captured = id;
  }
  hasPointerCapture(id: number) {
    return this.captured === id;
  }
  releasePointerCapture() {
    this.captured = null;
  }
  closest() {
    return null;
  }
  hasAttribute(name: string) {
    return (
      (name === "data-drop-zones" && !!this.dataset.zones) ||
      (name === "data-drop-split" && !!this.dataset.split)
    );
  }
  removeAttribute(name: string) {
    if (name === "data-drop") delete this.dataset.drop;
  }
  querySelectorAll() {
    return [];
  }
  cloneNode() {
    return new Element(this.box);
  }
  append(...nodes: Element[]) {
    nodes.forEach((n) => {
      n.parent = this;
      this.children.push(n);
    });
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((n) => n !== this);
  }
}
function page(t: TestContext, target: string | null, reduced = true) {
  const win = new EventTarget(),
    body = new Element(),
    source = new Element();
  const lane = new Element({ left: 200, top: 100, width: 100, height: 40 });
  lane.dataset = { drop: target ?? "", dropLabel: "role-x" };
  const targets = target ? [lane] : [];
  const restore: (() => void)[] = [];
  for (const [name, value] of Object.entries({
    window: Object.assign(win, { getSelection: () => null }),
    document: {
      body,
      createElement: () => new Element(),
      querySelectorAll: (selector: string) => (selector === "[data-drop]" ? targets : []),
      querySelector: () => null,
    },
    matchMedia: (): { matches: boolean } => ({ matches: reduced }),
    getComputedStyle: () => ({ getPropertyValue: () => "1" }),
    requestAnimationFrame: (): number => 1,
    cancelAnimationFrame: () => {},
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    innerWidth: 800,
    innerHeight: 600,
  })) {
    const was = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    restore.push(() =>
      was ? Object.defineProperty(globalThis, name, was) : Reflect.deleteProperty(globalThis, name),
    );
  }
  t.after(async () => {
    // The real owner removes its click guard in a zero-delay callback, including failed assertions.
    await new Promise((resolve) => setTimeout(resolve, 0));
    restore.forEach((f) => f());
  });
  const event = (type: string, x: number, y: number, pointerId = 7) =>
    Object.assign(new Event(type), { clientX: x, clientY: y, pointerId });
  const press = (extra = {}, options = {}) =>
    beginDrag(
      {
        button: 0,
        target: source,
        currentTarget: source,
        clientX: 30,
        clientY: 30,
        pointerId: 7,
      } as never,
      { kind: "node", id: "a", from: "map", ...extra },
      options,
    );
  const move = (x: number, y: number, id = 7) => win.dispatchEvent(event("pointermove", x, y, id));
  const up = (x: number, y: number, id = 7) => win.dispatchEvent(event("pointerup", x, y, id));
  return { win, body, source, lane, targets, press, move, up };
}

test("nested Dock targets preserve draft append and explicit cross-lane queue positions without widening map drops", async (t) => {
  const p = page(t, "lane:role-b"),
    drops: string[] = [];
  p.lane.box = { left: 0, top: 0, width: 300, height: 400 };
  const child = new Element({ left: 20, top: 80, width: 260, height: 90 });
  p.lane.append(child);
  p.targets.push(child);
  setDropHandler({ accepts: () => true, drop: (_, target) => drops.push(target) });
  child.dataset.drop = "card:draft";
  p.press({ from: undefined });
  p.move(150, 120);
  p.up(150, 120);
  assert.deepEqual(drops, ["card:draft"]);
  child.dataset = { drop: "at:card-spot", split: "true" };
  for (const [y, side] of [
    [90, "before"],
    [155, "after"],
  ] as const) {
    p.press({ kind: "card", id: "card-a", from: undefined });
    p.move(150, y);
    p.up(150, y);
    assert.equal(drops.at(-1), `at:card-spot:${side}`);
  }
  child.dataset = { drop: "card:draft" };
  p.press();
  p.move(150, 120);
  p.up(150, 120);
  assert.equal(drops.at(-1), "lane:role-b", "a map Node still dispatches only to the Role");
  p.lane.dataset.drop = "lane:";
  p.press();
  p.move(150, 120);
  p.up(150, 120);
  assert.equal(drops.length, 4, "neither the public tray nor draft accepts a map Node");
  await new Promise((resolve) => setTimeout(resolve, 0));
});
test("one capture keeps the original body and press anchor through a 24px Role approach", async (t) => {
  const p = page(t, "lane:role-x"),
    drops: string[] = [];
  setDropHandler({
    accepts: () => true,
    drop: (item, target) => drops.push(`${item.id}@${target}`),
  });
  const second = new Element();
  p.press({ ids: ["a", "b"] }, { originals: [p.source, second] });
  // Not held until the press is a drag, so a plain click still reaches what was pressed.
  assert.equal(p.source.captured, null);
  p.move(34, 30);
  assert.equal(p.body.children.length, 0); // Exactly 4px is still a click.
  assert.equal(p.source.captured, null);
  p.move(300, 120, 99);
  assert.equal(p.body.children.length, 0);
  p.move(35, 30);
  assert.equal(p.source.captured, 7);
  const ghost = p.body.children[0]!;
  assert.ok(ghost);
  assert.equal(p.source.style.transform, undefined);
  assert.ok(p.source.classes.has("is-drag-placeholder"));
  assert.ok(second.classes.has("is-drag-placeholder"));
  assert.equal(ghost.children.find((n) => n.className === "drag-count")!.textContent, "2");
  p.move(176, 120);
  assert.ok(p.lane.classes.has("is-drop-near"));
  assert.match(ghost.style.transform, /translate3d\(150px,90px,0\)/); // 146px motion + 4px attraction.
  p.up(176, 120, 99);
  assert.equal(drops.length, 0);
  assert.equal(p.source.captured, 7);
  p.up(176, 120);
  assert.deepEqual(drops, ["a@lane:role-x"]);
  assert.equal(p.source.captured, null);
  assert.equal(p.body.children.length, 0);
  assert.ok(!p.source.classes.has("is-drag-placeholder"));
  assert.ok(!second.classes.has("is-drag-placeholder"));
  await new Promise((r) => setTimeout(r, 0));
});
test("map topics never enter drafts/public, and Escape or pointer cancellation cleans the owner", async (t) => {
  const p = page(t, "card:draft"),
    drops: string[] = [];
  setDropHandler({ accepts: () => true, drop: (_, target) => drops.push(target) });
  p.press();
  p.move(210, 120);
  p.up(210, 120);
  assert.deepEqual(drops, []);
  p.press();
  p.move(210, 120);
  p.win.dispatchEvent(Object.assign(new Event("keydown"), { key: "Escape" }));
  assert.equal(p.source.captured, null);
  assert.equal(p.body.children.length, 0);
  p.press();
  p.move(210, 120);
  p.win.dispatchEvent(Object.assign(new Event("pointercancel"), { pointerId: 7 }));
  assert.equal(p.source.captured, null);
  assert.equal(p.body.children.length, 0);
  assert.deepEqual(drops, []);
  await new Promise((r) => setTimeout(r, 0));
});
test("drop eligibility and edge scrolling preserve the surface boundary", () => {
  const item = { kind: "node" as const, id: "a", from: "map" as const };
  for (const target of ["card:abc", "lane:", "topic:x", ""])
    assert.equal(mapDropAllowed(item, target), false);
  for (const target of ["lane:role-x", "tree:parent:inside", "tree:sibling:before"])
    assert.equal(mapDropAllowed(item, target), true);
  assert.ok(mapDropAllowed({ kind: "node", id: "a" }, "card:abc"));
  const box = { left: 100, right: 300, top: 50, bottom: 450 };
  assert.equal(distanceToBox(76, 100, box), 24);
  assert.ok(distanceToBox(76, 26, box) > 24);
  assert.ok(edgeScroll(52, box) < 0);
  assert.ok(edgeScroll(448, box) > 0);
  assert.equal(edgeScroll(250, box), 0);
  assert.equal(edgeScroll(49, box), 0);
});

test("normal motion configures an eased 180ms return and restores the original", async (t) => {
  const p = page(t, null, false);
  setDropHandler({ accepts: () => false, drop: () => assert.fail("empty map cannot drop") });
  p.press();
  p.move(90, 90);
  const ghost = p.body.children[0]!;
  p.up(90, 90);
  assert.equal(ghost.style.transform, "translate3d(0,0,0)");
  assert.match(ghost.style.transition, /transform 180ms ease-out/);
  assert.match(p.source.style.transition, /opacity 180ms ease-out/);
  assert.ok(!p.source.classes.has("is-drag-placeholder"));
  await new Promise((r) => setTimeout(r, 190));
  assert.equal(p.body.children.length, 0);
});
