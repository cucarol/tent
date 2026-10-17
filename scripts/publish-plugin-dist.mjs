import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hosts, validateHostPackage } from "./validate-plugin.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = promisify(execFile);
const catalogues = {
  codex: ".agents/plugins/marketplace.json",
  "claude-code": ".claude-plugin/marketplace.json",
};

/** Publish only the distribution as one root commit, without changing the source checkout or index. */
export async function publishPluginDistribution(distribution, remote) {
  const output = path.resolve(distribution),
    relative = path.relative(root, output);
  if (!/^(?:release|\.scratch)(?:[\\/]|$)/.test(relative) || path.isAbsolute(relative))
    throw new Error("Plugin distribution must be under this checkout's release/ or .scratch/.");
  if (!remote || remote.startsWith("-")) throw new Error("A Git remote is required");
  let version;
  for (const host of hosts) {
    const bundle = path.join(output, host, "plugins/tent");
    await validateHostPackage(bundle, host);
    const pkg = JSON.parse(await fs.readFile(path.join(bundle, "package.json"), "utf8"));
    if (version !== undefined && version !== pkg.version)
      throw new Error("Host package versions differ");
    version = pkg.version;
    const catalogue = JSON.parse(await fs.readFile(path.join(output, catalogues[host]), "utf8"));
    const source = catalogue.plugins?.[0]?.source;
    if (
      catalogue.name !== "tent" ||
      catalogue.plugins.length !== 1 ||
      catalogue.plugins[0].name !== "tent" ||
      (host === "codex"
        ? source?.source !== "local" || source.path !== `./${host}/plugins/tent`
        : source !== `./${host}/plugins/tent`)
    )
      throw new Error(`Invalid root catalogue for ${host}`);
  }
  const scratch = path.join(root, ".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(scratch, "plugin-dist-index-"));
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
    ),
    GIT_INDEX_FILE: path.join(temporary, "index"),
  };
  const git = async (args) =>
    (
      await run("git", args, { cwd: root, env, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
    ).stdout.trim();
  try {
    await git(["read-tree", "--empty"]);
    await git([
      "--work-tree",
      output,
      "add",
      "--force",
      "--",
      ".agents",
      ".claude-plugin",
      ...hosts,
    ]);
    const tree = await git(["write-tree"]);
    // No -p: plugin-dist never inherits source history or previous build outputs.
    const commit = await git([
      "-c",
      "user.name=github-actions[bot]",
      "-c",
      "user.email=41898282+github-actions[bot]@users.noreply.github.com",
      "commit-tree",
      tree,
      "-m",
      `chore(release): distribute Tent ${version}`,
    ]);
    await git(["push", "--force", remote, `${commit}:refs/heads/plugin-dist`]);
    return { branch: "plugin-dist", commit, tree, version };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 4)
    throw new Error("Usage: publish-plugin-dist.mjs <distribution-directory> <remote>");
  publishPluginDistribution(process.argv[2], process.argv[3]).then(
    (result) => process.stdout.write(JSON.stringify(result) + "\n"),
    (error) => {
      process.stderr.write(error.message + "\n");
      process.exitCode = 1;
    },
  );
}
