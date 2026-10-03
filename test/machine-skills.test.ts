import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { listSkills } from "./fixtures/bundled-skills.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fixture(t: { after: (callback: () => Promise<void>) => void }): Promise<string> {
  const scratch = path.join(repoRoot, ".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "skill-inventory-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("skill inventory only reports plugin-bundled directories with SKILL.md", async (t) => {
  const root = await fixture(t);
  for (const name of ["tent-role", "tent-node", "references", "scripts", "empty"]) {
    await fs.mkdir(path.join(root, "skills", name), { recursive: true });
  }
  for (const name of ["tent-role", "tent-node"]) {
    await fs.writeFile(path.join(root, "skills", name, "SKILL.md"), `# ${name}\n`);
  }
  await fs.mkdir(path.join(root, "skills", "empty", "SKILL.md"));
  assert.deepEqual(await listSkills(root), {
    source: "plugin-bundle",
    skills: [{ name: "tent-node" }, { name: "tent-role" }],
  });
});
