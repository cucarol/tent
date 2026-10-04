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
  const options = {
    absWorkingDir: root,
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
    await writeDependencyNotices(root, out, Object.keys(result.metafile.inputs));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  buildUi(root, { watch: process.argv.includes("--watch") }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
