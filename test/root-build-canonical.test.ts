import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { testScratchRoot } from "./scratch.js";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

type RootBuildContract = {
  canonicalBuildOptions(root: string): esbuild.BuildOptions;
  assertCanonicalMetafile(
    label: string,
    metafile: esbuild.Metafile,
    singletonPackages?: string[],
  ): void;
  assertCanonicalRootArtifacts(root: string, artifactNames: string[]): Promise<void>;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadContract(): Promise<RootBuildContract> {
  return (await import(
    pathToFileURL(path.join(repoRoot, "esbuild.config.mjs")).href
  )) as RootBuildContract;
}

async function writeFixtureSource(root: string): Promise<void> {
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "helper.ts"),
    'import singleton from "singleton-package";\nexport { singleton };\n',
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "src", "entry.ts"),
    [
      'import direct from "singleton-package";',
      'import { singleton as indirect } from "./helper.js";',
      'if (direct !== indirect) throw new Error("duplicate singleton");',
      'console.log("singleton-ok");',
      "",
    ].join("\n"),
    "utf8",
  );
}

async function writePhysicalPackage(root: string): Promise<void> {
  const packageRoot = path.join(root, "node_modules", "singleton-package");
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "singleton-package", version: "1.0.0", main: "index.js" }),
    "utf8",
  );
  await fs.writeFile(path.join(packageRoot, "index.js"), "export default {};\n", "utf8");
}

async function buildFixture(
  root: string,
  contract: RootBuildContract,
  preserveSymlinks: boolean,
): Promise<esbuild.BuildResult<esbuild.BuildOptions>> {
  return esbuild.build({
    ...contract.canonicalBuildOptions(root),
    preserveSymlinks,
    entryPoints: [path.join(root, "src", "entry.ts")],
    outfile: path.join(root, "cli.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    metafile: true,
    logLevel: "silent",
  });
}

async function unlinkFixtureJunction(junctionPath: string): Promise<void> {
  const attempts = process.platform === "win32" ? 4 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await fs.unlink(junctionPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      const retryable = process.platform === "win32" && (code === "EBUSY" || code === "EPERM");
      if (!retryable || attempt + 1 === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
}

test("root esbuild output is canonical across physical and junction node_modules", async () => {
  const contract = await loadContract();
  const tempRoot = await fs.mkdtemp(path.join(testScratchRoot(), "tent-root-build-"));
  const physicalRoot = path.join(tempRoot, "physical");
  const junctionRoot = path.join(tempRoot, "junction");
  const junctionModules = path.join(junctionRoot, "node_modules");

  try {
    await writeFixtureSource(physicalRoot);
    await writePhysicalPackage(physicalRoot);
    await writeFixtureSource(junctionRoot);
    await fs.symlink(
      path.join(physicalRoot, "node_modules"),
      junctionModules,
      process.platform === "win32" ? "junction" : "dir",
    );

    const physical = await buildFixture(physicalRoot, contract, true);
    const junction = await buildFixture(junctionRoot, contract, true);
    contract.assertCanonicalMetafile("physical", physical.metafile!, ["singleton-package"]);
    contract.assertCanonicalMetafile("junction", junction.metafile!, ["singleton-package"]);
    await contract.assertCanonicalRootArtifacts(physicalRoot, ["cli.mjs"]);
    await contract.assertCanonicalRootArtifacts(junctionRoot, ["cli.mjs"]);

    const [physicalBytes, junctionBytes] = await Promise.all([
      fs.readFile(path.join(physicalRoot, "cli.mjs")),
      fs.readFile(path.join(junctionRoot, "cli.mjs")),
    ]);
    assert.deepEqual(junctionBytes, physicalBytes, "root bundle must be byte-identical");

    const runtime = spawnSync(process.execPath, [path.join(junctionRoot, "cli.mjs")], {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    assert.equal(runtime.status, 0, runtime.stderr);
    assert.equal(runtime.stdout.trim(), "singleton-ok");

    const nonCanonical = await buildFixture(junctionRoot, contract, false);
    assert.throws(
      () => contract.assertCanonicalMetafile("junction-default", nonCanonical.metafile!),
      /non-canonical esbuild input/,
    );
  } finally {
    await unlinkFixtureJunction(junctionModules);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
