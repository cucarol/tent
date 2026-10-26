import assert from "node:assert/strict";
import { test } from "node:test";

test("canvas saves survive reload without applying keepalive's size limit to normal large saves", async (t) => {
  for (const [key, value] of Object.entries({
    location: { hash: "#token=fixture", pathname: "/", search: "" },
    sessionStorage: { setItem() {} },
    history: { replaceState() {} },
  })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() =>
      old ? Object.defineProperty(globalThis, key, old) : Reflect.deleteProperty(globalThis, key),
    );
  }
  const requests: RequestInit[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requests.push(init);
    return new Response(JSON.stringify({ etag: "saved" }), { status: 200 });
  });
  const { api } = await import("../src/ui/data/api.js");
  const small = { version: 3, open: [], shut: [], drawings: [] };
  await api.saveCanvas(null, small);
  assert.equal(requests[0]!.keepalive, true);
  assert.deepEqual(JSON.parse(requests[0]!.body as string), { baseEtag: null, canvas: small });
  await api.saveCanvas("old", {
    ...small,
    drawings: [{ id: "t", kind: "text", text: "字".repeat(24000) }],
  });
  assert.equal(requests[1]!.keepalive, false);
  await api.saveCanvas("old", small, true);
  assert.equal(requests[2]!.keepalive, true);
  assert.equal(requests[2]!.method, "PUT");
});
