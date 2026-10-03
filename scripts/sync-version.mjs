import * as fs from "node:fs/promises";
import * as path from "node:path";

/** package.json is the only edited version; builds refresh delivery manifests. */
export async function syncVersion(root) {
  const { version } = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  if (typeof version !== "string" || !version) throw new Error("package.json version is missing");
  for (const file of ["manifest.json", "plugins/tent/.codex-plugin/plugin.json"]) {
    const filename = path.join(root, file);
    const manifest = JSON.parse(await fs.readFile(filename, "utf8"));
    if (manifest.version === version) continue;
    manifest.version = version;
    await fs.writeFile(filename, JSON.stringify(manifest, null, 2) + "\n");
  }
}
