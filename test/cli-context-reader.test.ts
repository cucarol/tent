import assert from "node:assert/strict";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { nodeReadMaterials } from "../src/cli/read-paths.js";
import { testScratchRoot } from "./scratch.js";

test("material display preserves directory and prefix selectors without opening files", () => {
  assert.deepEqual(
    nodeReadMaterials(
      {
        resource: "../../output/missing%20file.md#Heading",
        sources: [
          { resource: "../../src/" },
          { resource: "../../src/node-*" },
          { resource: "../../" },
          {
            resource: pathToFileURL(
              path.resolve(testScratchRoot(), "nonexistent-material-display", "src") + path.sep,
            ).href,
          },
          { resource: "https://example.com/doc" },
          { resource: "conversation" },
        ],
      },
      "Owner",
      path.resolve(testScratchRoot(), "nonexistent-material-display"),
    ),
    [
      "output/missing file.md",
      "src/",
      "src/node-*",
      "./",
      "src/",
      "https://example.com/doc",
      "conversation",
    ],
  );
});
