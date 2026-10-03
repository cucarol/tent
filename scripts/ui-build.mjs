// Build the Web UI bundle into ui-dist/; --watch keeps a development build up to date.
import esbuild from "esbuild";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeDependencyNotices } from "./dependency-notices.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function buildUi(buildRoot = root, { watch = false, outputDir } = {}) {
  const root = path.resolve(buildRoot);
  const out = path.resolve(outputDir ?? path.join(root, "ui-dist"));

  // Only this dedicated build directory is replaced; stale chunks/maps/snapshots cannot ship.
  if (path.basename(out) !== "ui-dist" || !out.startsWith(root + path.sep))
    throw new Error("UI output must be a ui-dist directory inside the project");
  await fs.rm(out, { recursive: true, force: true });
  await fs.mkdir(out, { recursive: true });
  await fs.copyFile(path.join(root, "src/ui/index.html"), path.join(out, "index.html"));
  await fs.copyFile(
    path.join(root, "assets/icons/tent-mark-transparent-flat.svg"),
    path.join(out, "favicon.svg"),
  );
  // Excalidraw loads its fonts from EXCALIDRAW_ASSET_PATH; serve them locally.
  await fs.cp(
    path.join(root, "node_modules/@excalidraw/excalidraw/dist/prod/fonts"),
    path.join(out, "fonts"),
    { recursive: true },
  );

  // Excalidraw's zh-CN pack leaves some strings in English. Serve it through a module that fills them in from
  // src/ui/map/excalidrawZh.ts and re-exports every section by name, since Excalidraw reads the pack's named exports.
  const LOCALE = "excalidraw-zh-cn";
  const excalidrawZh = {
    name: LOCALE,
    setup(build) {
      build.onResolve({ filter: /[\\/]locales[\\/]zh-CN-\w+\.js$/ }, (args) => {
        if (args.namespace === LOCALE || !args.importer.includes("@excalidraw")) return undefined;
        return { path: path.join(args.resolveDir, args.path), namespace: LOCALE };
      });
      build.onLoad({ filter: /.*/, namespace: LOCALE }, async (args) => {
        const dir = path.dirname(args.path);
        const en = (await fs.readdir(dir)).find((f) => /^en-\w+\.js$/.test(f));
        const sections = Object.keys(
          (await import(pathToFileURL(path.join(dir, en)).href)).default,
        );
        return {
          resolveDir: root,
          contents: [
            `import * as upstream from ${JSON.stringify(args.path)};`,
            `import { withMissing } from "./src/ui/map/excalidrawZh.ts";`,
            "const pack = withMissing(upstream);",
            "export default pack;",
            `export const { ${sections.join(", ")} } = pack;`,
          ].join("\n"),
        };
      });
    },
  };

  const options = {
    absWorkingDir: root,
    plugins: [excalidrawZh],
    entryPoints: { app: "src/ui/main.tsx" },
    bundle: true,
    format: "esm",
    splitting: true,
    chunkNames: "chunks/[name]-[hash]",
    outdir: out,
    jsx: "automatic",
    target: "es2022",
    conditions: [watch ? "development" : "production"],
    define: { "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production") },
    loader: { ".woff2": "file", ".ttf": "file", ".png": "file" },
    sourcemap: watch,
    minify: !watch,
    logLevel: "info",
    metafile: true,
  };

  if (watch) {
    const context = await esbuild.context(options);
    await context.watch();
  } else {
    const result = await esbuild.build(options);
    await writeDependencyNotices(
      root,
      out,
      Object.keys(result.metafile.inputs).filter((input) => !input.startsWith(LOCALE + ":")),
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  buildUi(root, { watch: process.argv.includes("--watch") }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
