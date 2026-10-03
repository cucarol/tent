import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Notices for packages actually included by esbuild, including nested dependency versions. */
export async function writeDependencyNotices(root, output, inputs) {
  const packages = new Set();
  for (const input of inputs) {
    const match = input.replaceAll("\\", "/").match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
    if (match) packages.add(match[1]);
  }
  const notices = [];
  for (const directory of [...packages].sort()) {
    const absolute = path.resolve(root, directory);
    const pkg = JSON.parse(await fs.readFile(path.join(absolute, "package.json"), "utf8"));
    const files = (await fs.readdir(absolute)).filter((name) =>
      /^(licen[sc]e|copying|notice)(\.|$)/i.test(name),
    );
    const licenseTexts = [];
    for (const file of files) {
      if ((await fs.stat(path.join(absolute, file))).isFile())
        licenseTexts.push(await fs.readFile(path.join(absolute, file), "utf8"));
    }
    notices.push(
      `${pkg.name}@${pkg.version}\nLicense: ${JSON.stringify(pkg.license ?? pkg.licenses ?? "See package source")}\n${licenseTexts.join("\n")}`,
    );
  }
  await fs.writeFile(
    path.join(output, "THIRD_PARTY_NOTICES.txt"),
    notices.join("\n\n--------------------\n\n"),
  );
}
