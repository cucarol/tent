import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import test from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { serializeFrontmatter } from "../src/core/frontmatter.js";
import { exportGraph } from "../src/fs/graph-export.js";

test("export validates standard bundle materials and reports external and unresolved occurrences without copying them", async (t) => {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(scratch, "standard-export-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await scaffoldInWorkspace(new NodeFs(workspace), {
    name: "standard export",
    nodes: [{ id: "node-material", name: "Material", type: "prompt" }],
  });
  const systemRoot = path.join(workspace, ".tent"),
    adapter = new NodeFs(systemRoot);
  const raw = serializeFrontmatter(
    {
      id: "node-material",
      type: "prompt",
      resource: "./owned.bin",
      sources: [
        { resource: "../../outside.txt" },
        { resource: "population scope" },
        { resource: "https://example.com/reference" },
        { resource: "../../outside.txt", title: "same file, other purpose" },
      ],
    },
    "Context\r\n",
  );
  await adapter.writeFile("Material/Material.md", raw);
  await fs.writeFile(path.join(workspace, "outside.txt"), "external bytes");
  const mount = {
    workspaceRoot: workspace,
    systemRoot,
    workspaceId: "ws-standard-export",
    env: { fs: adapter },
  };
  await assert.rejects(
    exportGraph(mount, { outputDir: "output/missing" }),
    /Owned material missing/,
  );
  await adapter.writeBinary("Material/owned.bin", Buffer.from([0, 1, 255]));
  const ordinaryNode = serializeFrontmatter(
    { id: "node-ordinary", type: "prompt" },
    "Current Node",
  );
  await adapter.writeFile("version-leases/version-leases.md", ordinaryNode);
  await adapter.writeFile("mutation.lock.guard.stale-test/owner.json", '{"pid":1}');
  const result = await exportGraph(mount, { outputDir: "output/valid" });
  const manifest = JSON.parse(
    await fs.readFile(path.join(result.outputDir, "tent-export.json"), "utf8"),
  );
  assert.equal(manifest.externalNotPacked.length, 3);
  assert.deepEqual(
    manifest.externalNotPacked.map((item: { index: number }) => item.index),
    [0, 2, 3],
  );
  assert.equal(manifest.unresolvedMaterials[0].resource, "population scope");
  assert.equal(
    await fs.readFile(path.join(result.outputDir, ".tent/Material/Material.md"), "utf8"),
    raw,
  );
  assert.equal(
    await fs.readFile(
      path.join(result.outputDir, ".tent/version-leases/version-leases.md"),
      "utf8",
    ),
    ordinaryNode,
  );
  await assert.rejects(
    fs.stat(path.join(result.outputDir, ".tent/mutation.lock.guard.stale-test")),
    { code: "ENOENT" },
  );
  await assert.rejects(fs.stat(path.join(result.outputDir, "outside.txt")), { code: "ENOENT" });
});

for (const outcome of ["success", "failure"]) {
  test(
    `Windows export publication retries sharing errors with ${outcome} and leaves no staging directory`,
    { skip: process.platform !== "win32" },
    async (t) => {
      const scratch = path.resolve(".scratch");
      await fs.mkdir(scratch, { recursive: true });
      const workspace = await fs.mkdtemp(path.join(scratch, "export-rename-"));
      t.after(() => fs.rm(workspace, { recursive: true, force: true }));
      await scaffoldInWorkspace(new NodeFs(workspace), { name: "rename retry" });
      const systemRoot = path.join(workspace, ".tent"),
        destination = path.join(workspace, "output", "bundle"),
        mount = {
          workspaceRoot: workspace,
          systemRoot,
          workspaceId: "ws-export-rename",
          env: { fs: new NodeFs(systemRoot) },
        },
        originalRename = fsPromises.rename,
        failure = Object.assign(new Error("export directory occupied"), { code: "EBUSY" });
      let attempts = 0;
      const mocked = t.mock.method(
        fsPromises,
        "rename",
        async (...args: Parameters<typeof originalRename>) => {
          const [from, to] = args;
          if (to === destination && (++attempts <= 2 || outcome === "failure")) throw failure;
          return originalRename(from, to);
        },
      );
      syncBuiltinESMExports();
      try {
        const publication = exportGraph(mount, { outputDir: "output/bundle" });
        if (outcome === "failure") await assert.rejects(publication, (error) => error === failure);
        else assert.equal((await publication).outputDir, destination);
      } finally {
        mocked.mock.restore();
        syncBuiltinESMExports();
      }
      assert.equal(attempts, outcome === "success" ? 3 : 10);
      assert.deepEqual(
        await fs.readdir(path.dirname(destination)),
        outcome === "success" ? ["bundle"] : [],
      );
      if (outcome === "failure") {
        await assert.rejects(fs.stat(destination), { code: "ENOENT" });
        await exportGraph(mount, { outputDir: "output/bundle" });
      }
      const manifest = JSON.parse(
        await fs.readFile(path.join(destination, "tent-export.json"), "utf8"),
      );
      assert.equal(manifest.workspaceId, mount.workspaceId);
      assert.deepEqual(
        await fs.readFile(path.join(destination, ".tent", "settings.json")),
        await fs.readFile(path.join(systemRoot, "settings.json")),
      );
    },
  );
}
