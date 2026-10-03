// Read-only inventory of the skills shipped with this plugin package.

import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface SkillListResult {
  source: "plugin-bundle";
  skills: Array<{ name: string }>;
}

/** Discover skill directories in the package, excluding shared resources. */
export async function listBundledSkillNames(packageRoot: string): Promise<string[]> {
  const skillsDir = path.join(packageRoot, "skills");
  const entries = await fs.readdir(skillsDir, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const skill = await fs.stat(path.join(skillsDir, entry.name, "SKILL.md"));
      if (skill.isFile()) names.push(entry.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return names.sort();
}

/** This inventory does not claim that any separate host copy is installed or runnable. */
export async function listSkills(packageRoot: string): Promise<SkillListResult> {
  const names = await listBundledSkillNames(packageRoot);
  return { source: "plugin-bundle", skills: names.map((name) => ({ name })) };
}
