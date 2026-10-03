import esbuild from "esbuild";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isBuiltin } from "node:module";
import { syncVersion } from "./scripts/sync-version.mjs";
import { buildUi } from "./scripts/ui-build.mjs";
import { buildIdentity } from "./scripts/build-identity.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

export function canonicalBuildOptions(buildRoot) {
  return {
    absWorkingDir: path.resolve(buildRoot),
    // Parallel worktrees may junction node_modules to the shared checkout. Keep
    // esbuild module identity at the logical worktree root so bundle labels do
    // not depend on the junction's physical target.
    preserveSymlinks: true,
  };
}

function slash(value) {
  return value.replaceAll("\\", "/");
}

export function assertCanonicalMetafile(label, metafile, singletonPackages = []) {
  const inputs = Object.keys(metafile.inputs).map(slash);
  for (const input of inputs) {
    if (
      path.isAbsolute(input) ||
      input.startsWith("../") ||
      input.includes("/../") ||
      /Tent-worktrees/i.test(input)
    ) {
      throw new Error(`${label}: non-canonical esbuild input ${input}`);
    }
    if (!input.startsWith("src/") && !input.startsWith("node_modules/")) {
      throw new Error(`${label}: input is outside src/ or node_modules/: ${input}`);
    }
  }

  for (const packageName of singletonPackages) {
    const marker = `node_modules/${packageName}/`;
    const roots = new Set(
      inputs
        .filter((input) => input.includes(marker))
        .map((input) => input.slice(0, input.indexOf(marker) + marker.length - 1)),
    );
    if (roots.size !== 1) {
      throw new Error(
        `${label}: expected exactly one ${packageName} module root, found ${
          [...roots].join(", ") || "none"
        }`,
      );
    }
  }
}

export async function assertCanonicalRootArtifacts(buildRoot, artifactNames) {
  for (const name of artifactNames) {
    const file = path.join(path.resolve(buildRoot), name);
    const text = await fs.readFile(file, "utf8");
    const portable = slash(text);
    if (
      /(?:^|[^A-Za-z])[A-Za-z]:[\\/](?![\\/])/.test(text) ||
      portable.includes("../../Tent/node_modules/") ||
      /Tent-worktrees/i.test(portable)
    ) {
      throw new Error(`${name}: contains a machine- or lane-specific path`);
    }
  }
}

export function rootBundleOptions(buildRoot) {
  const absoluteRoot = path.resolve(buildRoot);
  const shared = {
    ...canonicalBuildOptions(absoluteRoot),
    bundle: true,
    external: ["node:*", "zod", "zod/*", "yaml", "mdast-util-from-markdown"],
    format: "esm",
    target: "es2021",
    logLevel: "info",
    sourcemap: false,
    treeShaking: true,
    platform: "node",
    metafile: true,
    define: {
      __TENT_BUILD_IDENTITY_JSON__: JSON.stringify(JSON.stringify(buildIdentity(absoluteRoot))),
    },
  };
  return [
    {
      label: "root-cli",
      artifact: "cli.mjs",
      options: {
        ...shared,
        entryPoints: ["src/cli/tent.ts"],
        outfile: path.join(absoluteRoot, "cli.mjs"),
      },
    },
  ];
}

/** 插件携带完整 Node 程序，安装后不再通过 npm 或 Desktop 补运行依赖。 */
export async function buildPluginRuntime(buildRoot, outputRoot) {
  const inputs = new Set();
  const identity = buildIdentity(buildRoot);
  for (const [artifact, entry] of [["cli", "src/cli/tent.ts"]]) {
    const result = await esbuild.build({
      ...canonicalBuildOptions(buildRoot),
      entryPoints: [entry],
      outfile: path.join(outputRoot, `${artifact}.mjs`),
      bundle: true,
      // 所有应用依赖打包到运行时；仅 Node 内置模块留在外部。
      external: ["node:*"],
      platform: "node",
      format: "esm",
      target: "node22",
      metafile: true,
      define: { __TENT_BUILD_IDENTITY_JSON__: JSON.stringify(JSON.stringify(identity)) },
      minifyWhitespace: true,
      minifySyntax: true,
      logLevel: "warning",
      banner: {
        js:
          'import { createRequire as __tentCreateRequire } from "node:module";\n' +
          "const require = __tentCreateRequire(import.meta.url);\n",
      },
    });
    assertCanonicalMetafile(`plugin-${artifact}`, result.metafile);
    for (const input of Object.keys(result.metafile.inputs)) inputs.add(input);
    for (const output of Object.values(result.metafile.outputs)) {
      const unbundled = output.imports.filter((item) => item.external && !isBuiltin(item.path));
      if (unbundled.length)
        throw new Error(`Plugin has external runtime imports: ${JSON.stringify(unbundled)}`);
    }
  }
  await assertCanonicalRootArtifacts(outputRoot, ["cli.mjs"]);
  return [...inputs].sort();
}

export async function build(buildRoot = root, production = false) {
  await syncVersion(buildRoot);
  const bundles = rootBundleOptions(buildRoot);
  if (production) {
    for (const bundle of bundles) {
      const result = await esbuild.build(bundle.options);
      assertCanonicalMetafile(bundle.label, result.metafile);
    }
    await assertCanonicalRootArtifacts(
      buildRoot,
      bundles.map((bundle) => bundle.artifact),
    );
    await buildUi(buildRoot);
    return;
  }

  for (const bundle of bundles) {
    const context = await esbuild.context(bundle.options);
    await context.watch();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  build(root, process.argv[2] === "production").catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
