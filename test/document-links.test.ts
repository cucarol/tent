import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalDocumentLinks } from "../src/core/document-links.js";

test("known Node IDs become relative Markdown destinations without changing surrounding prose", () => {
  const paths = new Map([["node-alpha", "Alpha/Alpha.md"]]);
  const source =
    "[Alpha](node-alpha#part) [also][ref]\n\n[ref]: node-alpha\n\nnode-alpha [[node-alpha]] `[code](node-alpha)`";
  assert.equal(
    canonicalDocumentLinks(source, paths, "Beta/Beta.md"),
    "[Alpha](../Alpha/Alpha.md#part) [also][ref]\n\n[ref]: ../Alpha/Alpha.md\n\nnode-alpha [[node-alpha]] `[code](node-alpha)`",
  );
  assert.equal(
    canonicalDocumentLinks("[unknown](node-missing)", paths, "Beta/Beta.md"),
    "[unknown](node-missing)",
  );
  assert.equal(
    canonicalDocumentLinks("[self](node-alpha)", paths, "Alpha/Alpha.md"),
    "[self](./Alpha.md)",
  );
});
