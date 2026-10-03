import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildPluginRuntime } from "../esbuild.config.mjs";
import { syncVersion } from "./sync-version.mjs";
import { buildUi } from "./ui-build.mjs";
import { writeDependencyNotices } from "./dependency-notices.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function slash(value) {
  return value.replaceAll("\\", "/");
}

/** 只生成到尚不存在的交付目录，失败时保留现场，不删除用户文件。 */
export async function buildPlugin(outputRoot = path.join(root, "release/plugins/tent")) {
  await syncVersion(root);
  const output = path.resolve(outputRoot);
  if (path.basename(output) !== "tent" || path.basename(path.dirname(output)) !== "plugins") {
    throw new Error("Plugin output must end with plugins/tent.");
  }
  const relative = path.relative(root, output);
  if (!/^(release|\.scratch)[\\/]/.test(relative) || path.isAbsolute(relative)) {
    throw new Error("Plugin output must be under this checkout's release/ or .scratch/.");
  }
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.mkdir(output);
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  await fs.cp(path.join(root, "plugins/tent"), output, { recursive: true });
  await fs.mkdir(path.join(output, "skills"));
  await fs.cp(path.join(root, "skill-resources"), path.join(output, "skill-resources"), {
    recursive: true,
  });
  for (const name of ["tent-init", "tent-node", "tent-role", "tent-card"]) {
    await fs.cp(path.join(root, "skills", name), path.join(output, "skills", name), {
      recursive: true,
    });
    const metadata = path.join(output, "skills", name, "agents/openai.yaml");
    const text = await fs.readFile(metadata, "utf8");
    await fs.writeFile(metadata, text.replaceAll(`$${name}`, `$tent:${name}`));
  }
  await fs.mkdir(path.join(output, "docs"));
  for (const name of ["SPEC.md", "PLUGIN.md"]) {
    await fs.copyFile(path.join(root, "docs", name), path.join(output, "docs", name));
  }
  await fs.copyFile(path.join(root, "LICENSE"), path.join(output, "LICENSE"));
  const manifestPath = path.join(output, ".codex-plugin/plugin.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.version = pkg.version;
  await writeJson(manifestPath, manifest);
  await writeJson(path.join(output, "package.json"), {
    name: pkg.name,
    version: pkg.version,
    private: true,
    type: "module",
    engines: pkg.engines,
    license: pkg.license,
  });
  const inputs = await buildPluginRuntime(root, output);
  await writeDependencyNotices(root, output, inputs);
  await buildUi(root, { outputDir: path.join(output, "ui-dist") });
  // 交付目录自带可安装来源，不注册或修改用户的全局 marketplace。
  const catalogue = path.join(
    path.dirname(path.dirname(output)),
    ".agents/plugins/marketplace.json",
  );
  await fs.mkdir(path.dirname(catalogue), { recursive: true });
  await fs.writeFile(
    catalogue,
    JSON.stringify(
      {
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
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  return output;
}

async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length > 3) throw new Error("Usage: build-plugin.mjs [output-directory]");
  buildPlugin(process.argv[2])
    .then((output) => process.stdout.write(`${output}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
