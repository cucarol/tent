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

test("bounded destination edits use complete reference context and leave destinations outside the range exact", () => {
  const paths = new Map([["node-alpha", "Alpha/Alpha.md"]]);
  const retained = "[outside inline](node-alpha) [Alpha][ref]\n\n";
  const changed = '[ref]: <node-alpha#part> "title"';
  const source = retained + changed + "\n";
  assert.equal(
    canonicalDocumentLinks(source, paths, "Beta/Beta.md", {
      start: retained.length,
      end: retained.length + changed.length,
    }),
    retained + '[ref]: <../Alpha/Alpha.md#part> "title"\n',
  );
  const existingDefinition = "[ref]: node-alpha\n\n";
  const newUse = "[Alpha][ref] [inline](node-alpha)";
  assert.equal(
    canonicalDocumentLinks(existingDefinition + newUse, paths, "Beta/Beta.md", {
      start: existingDefinition.length,
      end: existingDefinition.length + newUse.length,
    }),
    existingDefinition + "[Alpha][ref] [inline](../Alpha/Alpha.md)",
  );
});
