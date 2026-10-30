import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildPluginRuntime } from "../esbuild.config.mjs";
import { syncVersion } from "./sync-version.mjs";
import { buildUi } from "./ui-build.mjs";
import { writeDependencyNotices } from "./dependency-notices.mjs";
import {
  hostDocuments,
  hosts,
  validateSourceDocuments,
  validateHostPackage,
} from "./validate-plugin.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A fresh distribution contains both hosts; existing deliveries are never overwritten. */
export async function buildPlugin(outputRoot = path.join(root, "release")) {
  const output = path.resolve(outputRoot);
  const relative = path.relative(root, output);
  if (!/^(?:release|\.scratch)(?:[\\/]|$)/.test(relative) || path.isAbsolute(relative))
    throw new Error("Plugin distribution must be under this checkout's release/ or .scratch/.");
  for (const host of hosts) await validateSourceDocuments(root, host);
  await syncVersion(root);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.mkdir(output);
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const first = path.join(output, hosts[0], "plugins/tent");
  await fs.mkdir(first, { recursive: true });
  for (const directory of ["skills", "skill-resources"])
    await fs.cp(path.join(root, directory), path.join(first, directory), { recursive: true });
  await fs.mkdir(path.join(first, "docs"));
  for (const name of ["SPEC.md", "PLUGIN.md"])
    await fs.copyFile(path.join(root, "docs", name), path.join(first, "docs", name));
  await fs.copyFile(path.join(root, "LICENSE"), path.join(first, "LICENSE"));
  await writeJson(path.join(first, "package.json"), {
    name: pkg.name,
    version: pkg.version,
    private: true,
    type: "module",
    engines: pkg.engines,
    license: pkg.license,
  });
  const inputs = await buildPluginRuntime(root, first);
  await writeDependencyNotices(root, first, inputs);
  await buildUi(root, { outputDir: path.join(first, "ui-dist") });
  // Copy before applying shells: runtime, UI and common documents have identical bytes.
  for (const host of hosts.slice(1))
    await fs.cp(first, path.join(output, host, "plugins/tent"), { recursive: true });
  for (const host of hosts) {
    const bundle = path.join(output, host, "plugins/tent");
    const shell = path.join(root, "plugins", host, "tent");
    await fs.cp(shell, bundle, {
      recursive: true,
      filter: (source) => !Object.hasOwn(hostDocuments, path.relative(shell, source)),
    });
    for (const [name, target] of Object.entries(hostDocuments)) {
      await fs.mkdir(path.dirname(path.join(bundle, target)), { recursive: true });
      await fs.copyFile(path.join(shell, name), path.join(bundle, target));
    }
    await validateHostPackage(bundle, host);
    const catalogue =
      host === "codex" ? ".agents/plugins/marketplace.json" : ".claude-plugin/marketplace.json";
    const marketplace =
      host === "codex"
        ? {
            name: "tent-local",
            interface: { displayName: "Tent local distribution" },
            plugins: [
              {
                name: "tent",
                source: { source: "local", path: "./plugins/tent" },
                policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
                category: "Productivity",
              },
            ],
          }
        : {
            name: "tent-local",
            owner: { name: "cucarol" },
            plugins: [{ name: "tent", source: "./plugins/tent" }],
          };
    const filename = path.join(output, host, catalogue);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await writeJson(filename, marketplace);
    // Git installs enter the distribution root; ZIP/local installs keep each
    // host's existing tent-local catalogue and ./plugins/tent address.
    const sharedCatalogue = path.join(output, catalogue);
    await fs.mkdir(path.dirname(sharedCatalogue), { recursive: true });
    await writeJson(sharedCatalogue, {
      ...marketplace,
      name: "tent",
      ...(host === "codex" ? { interface: { displayName: "Tent" } } : {}),
      plugins: marketplace.plugins.map((plugin) => ({
        ...plugin,
        source:
          host === "codex"
            ? { source: "local", path: `./${host}/plugins/tent` }
            : `./${host}/plugins/tent`,
      })),
    });
  }
  return output;
}

async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length > 3) throw new Error("Usage: build-plugin.mjs [distribution-directory]");
  buildPlugin(process.argv[2])
    .then((output) => process.stdout.write(`${output}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
