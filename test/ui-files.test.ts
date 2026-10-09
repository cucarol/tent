import assert from "node:assert/strict";
import test from "node:test";
import { fileKind, fileOf, filePaths, fileSize, infoOf } from "../src/ui/data/files.js";
import type { Snapshot, SnapshotMaterial, SnapshotNode } from "../src/ui/data/types.js";

const node = (id: string, type: string, materials: SnapshotMaterial[]) =>
  ({ id, type, materials }) as unknown as SnapshotNode;

test("a file is shown by its suffix", () => {
  const cases: [string, string][] = [
    ["out/report.html", "html"],
    ["out/REPORT.HTM", "html"],
    ["shots/a.png", "image"],
    ["shots/a.svg", "image"],
    ["clips/demo.mp4", "video"],
    ["clips/demo.webm", "video"],
    ["voice/note.mp3", "audio"],
    ["voice/note.wav", "audio"],
    ["docs/SPEC.md", "text"],
    ["src/ui/App.tsx", "text"],
    ["src/core/x.mjs", "text"],
    ["docs/SPEC.md#Reception", "text"],
    ["data/model.bin", "other"],
    ["slides/deck.pdf", "other"],
    ["Makefile", "other"],
  ];
  for (const [resource, kind] of cases) assert.equal(fileKind(resource), kind, resource);
});

test("the file is the Node's resource, whatever its type or tags", () => {
  const output = node("node-a", "output", [
    { kind: "file", resource: "../../out/r.html", workspacePath: "out/r.html", field: "resource" },
  ]);
  assert.deepEqual(fileOf(output), {
    kind: "file",
    path: "out/r.html",
    name: "r.html",
    ext: "html",
    show: "html",
  });
  // A goal's sources are materials it reads, not its own file.
  const goal = node("node-g", "goal", [
    { kind: "file", resource: "../docs/req.md", workspacePath: "docs/req.md", field: "sources" },
  ]);
  assert.equal(fileOf(goal), null);
  const remote = node("node-r", "output-asset", [
    {
      kind: "uri",
      resource: "https://example.com/v.mp4",
      uri: "https://example.com/v.mp4",
      field: "resource",
    },
  ]);
  assert.deepEqual(fileOf(remote), { kind: "uri", uri: "https://example.com/v.mp4" });
  const noSuffix = node("node-m", "output", [
    { kind: "file", resource: "../Makefile", workspacePath: "Makefile", field: "resource" },
  ]);
  assert.equal((fileOf(noSuffix) as { ext: string }).ext, "");
  const snapshot = { nodes: [output, goal, remote, noSuffix, output] } as unknown as Snapshot;
  assert.deepEqual(filePaths(snapshot), ["out/r.html", "Makefile"]);
});

test("file sizes read in the nearest unit", () => {
  assert.equal(fileSize(512), "512 B");
  assert.equal(fileSize(1536), "1.5 KB");
  assert.equal(fileSize(20 * 1024 * 1024), "20 MB");
});

test("file info is read from the map's own keys", () => {
  assert.equal(infoOf({}, "__proto__"), undefined, "not known yet");
  assert.equal(infoOf({}, "toString"), undefined);
  const files = JSON.parse('{"__proto__":null,"a.png":{"size":3,"modifiedAt":"x"}}');
  assert.equal(infoOf(files, "__proto__"), null, "missing");
  assert.equal(infoOf(files, "a.png")!.size, 3);
});
