import assert from "node:assert/strict";
import fs from "node:fs/promises";
import nodeFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { startUiServer } from "../src/ui-server/server.js";
import { directoryPath, resolveHref } from "../src/ui/util.js";
import { localFileAt } from "../src/ui/data/files.js";
import type { WorkspaceDirectory } from "../src/core/read/workspace-directory.js";
import { initializeFixtureWorkspace, testScratchRoot } from "./scratch.js";

test("body directory routing preserves the marker, encoding and .tent anchor", () => {
  const from = "Author/Author.md";
  assert.equal(directoryPath(from, "../../source%20folder/"), "source folder");
  assert.equal(directoryPath(from, "../../hash%23percent%25/"), "hash#percent%");
  assert.equal(directoryPath(from, "../../"), "");
  assert.equal(directoryPath(from, "/group/"), ".tent/group");
  assert.equal(directoryPath(from, "../Other/"), ".tent/Other");
  assert.equal(directoryPath(from, "file:///workspace/folder/"), "file:///workspace/folder/");
  for (const target of [
    "../../folder",
    "../../folder/#part",
    "../../folder/?q=1",
    "/../folder/",
    "../../../outside/",
    "//host/folder/",
    "%2F%2Fhost/",
    "https://example.invalid/folder/",
    "file:///workspace/folder/#part",
    "node-abc123",
    "../../bad%ZZ/",
    "../../bad%5Cname/",
  ])
    assert.equal(directoryPath(from, target), null, target);
  assert.deepEqual(resolveHref(from, "../Other/Other.md#part"), { tentPath: "Other/Other.md" });
  assert.deepEqual(localFileAt("source folder/note.md"), {
    kind: "file",
    path: "source folder/note.md",
    name: "note.md",
    ext: "md",
    show: "text",
  });
  assert.equal(localFileAt("source folder/alpha #%.txt").show, "text");
});

test("directory API reads one level in directory-first name order and shares file previews", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "ui-directory-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });
  const workspace = path.join(root, "workspace");
  await initializeFixtureWorkspace(workspace);
  const directory = path.join(workspace, "source folder");
  await fs.mkdir(path.join(directory, "z-dir/deeper"), { recursive: true });
  await fs.mkdir(path.join(directory, "a-dir"));
  await fs.mkdir(path.join(directory, ".git"));
  await fs.writeFile(path.join(directory, ".git/secret"), "hidden");
  await fs.writeFile(path.join(directory, "z-file.txt"), "file preview\n");
  await fs.writeFile(path.join(directory, "a#%.txt"), "encoded path preview\n");
  await fs.writeFile(path.join(directory, "z-dir/deeper/never-listed.txt"), "nested");
  await fs.writeFile(path.join(directory, "binary.txt"), Buffer.from([0, 1]));
  await fs.writeFile(path.join(directory, "long.txt"), "line\n".repeat(60000));
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "outside.txt"), "outside");
  await fs.symlink(outside, path.join(directory, "outside-alias"), "junction");
  await fs.symlink(path.join(directory, ".git"), path.join(directory, "git-alias"), "junction");
  const dist = path.join(root, "ui-dist");
  await fs.mkdir(dist);
  const server = await startUiServer({ workspaceRoot: workspace, staticDir: dist, port: 0 });
  t.after(() => server.close());
  const token = new URL(server.url).hash.slice("#token=".length);
  const origin = `http://127.0.0.1:${server.port}`;
  const get = (route: string, auth = true) =>
    fetch(origin + route, { headers: auth ? { Authorization: `Bearer ${token}` } : {} });
  const route = (target: string) => `/api/directories?path=${encodeURIComponent(target)}`;
  assert.equal((await get(route("source folder"), false)).status, 401);
  const original = nodeFs.promises.readdir;
  const listed: string[] = [];
  nodeFs.promises.readdir = (async (...args: Parameters<typeof original>) => {
    listed.push(String(args[0]));
    return original(...args);
  }) as typeof original;
  syncBuiltinESMExports();
  let listing: WorkspaceDirectory;
  try {
    const reply = await get(route("source folder"));
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get("cache-control"), "no-store");
    listing = (await reply.json()) as WorkspaceDirectory;
  } finally {
    nodeFs.promises.readdir = original;
    syncBuiltinESMExports();
  }
  assert.deepEqual(listed, [await fs.realpath(directory)]);
  assert.equal(listing.path, "source folder");
  assert.equal(listing.parent, "");
  assert.deepEqual(
    listing.entries.map((entry) => [entry.name, entry.kind]),
    [
      ["a-dir", "directory"],
      ["z-dir", "directory"],
      ["a#%.txt", "file"],
      ["binary.txt", "file"],
      ["long.txt", "file"],
      ["z-file.txt", "file"],
    ],
  );
  const nested = (await (await get(route("source folder/z-dir"))).json()) as WorkspaceDirectory;
  assert.equal(nested.parent, "source folder");
  assert.deepEqual(
    nested.entries.map((entry) => entry.name),
    ["deeper"],
  );
  const top = (await (await get(route(""))).json()) as WorkspaceDirectory;
  assert.equal(top.parent, null);
  assert.equal(
    top.entries.some((entry) => entry.name === ".git"),
    false,
  );
  assert.equal((await get(route(pathToFileURL(directory + path.sep).href))).status, 200);
  for (const target of [
    "../outside",
    ".git",
    "source folder/.git",
    "source folder/git-alias",
    "source folder/outside-alias",
    "source folder/../source folder",
    pathToFileURL(root + path.sep).href,
  ])
    assert.equal((await get(route(target))).status, 403, target);
  assert.equal((await get(route("missing"))).status, 404);
  assert.equal((await get(route("source folder/z-file.txt"))).status, 404);
  const file = "source folder/a#%.txt";
  const textReply = await get(`/api/files/text?path=${encodeURIComponent(file)}`);
  assert.equal(textReply.status, 200);
  assert.equal(((await textReply.json()) as { text: string }).text, "encoded path preview\n");
  assert.equal((await get(`/api/files?path=${encodeURIComponent(file)}`)).status, 200);
  const large = (await (
    await get(`/api/files/text?path=${encodeURIComponent("source folder/long.txt")}`)
  ).json()) as { text: string; truncated: boolean };
  assert.equal(large.truncated, true);
  assert.ok(large.text.length <= 256 * 1024);
  assert.equal(
    (await get(`/api/files/text?path=${encodeURIComponent("source folder/binary.txt")}`)).status,
    415,
  );
  for (const target of ["../outside.txt", ".git/config", "source folder/.git/secret"])
    assert.equal(
      (await get(`/api/files/text?path=${encodeURIComponent(target)}`)).status,
      403,
      target,
    );
  assert.equal((await get(`/api/files/text?path=${encodeURIComponent(file)}`, false)).status, 401);
});
