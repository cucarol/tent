import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Keep every disposable test fixture inside this checkout. */
export function testScratchRoot(): string {
  const root = fileURLToPath(new URL("../.scratch/", import.meta.url));
  mkdirSync(root, { recursive: true });
  return root;
}
