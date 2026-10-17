import assert from "node:assert/strict";
import { test } from "node:test";
import { pictureName } from "../src/ui/map/picture.js";

test("a map picture is named by its workspace and local time, safe as a file name", () => {
  const at = new Date(2026, 9, 17, 9, 5);
  assert.equal(pictureName("react-ws", at), "react-ws-map-20261017-0905.png");
  assert.equal(pictureName("我的 项目/a:b", at), "我的-项目-a-b-map-20261017-0905.png");
  assert.equal(pictureName("  ", at), "tent-map-20261017-0905.png");
});
