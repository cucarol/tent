import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { initializeTentWorkspace } from "../src/fs/workspace-init.js";
import { fileURLToPath } from "node:url";

/** Keep every disposable test fixture inside this checkout. */
export function testScratchRoot(): string {
  const root = fileURLToPath(new URL("../.scratch/", import.meta.url));
  mkdirSync(root, { recursive: true });
  return root;
}

/** Fixture initialization must never modify the checkout's shared Git exclude file. */
export function initializeFixtureRepository(root: string): void {
  mkdirSync(root, { recursive: true });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  );
  execFileSync("git", ["-C", root, "init", "--quiet"], { env, windowsHide: true });
}

export async function initializeFixtureWorkspace(root: string): Promise<void> {
  initializeFixtureRepository(root);
  await initializeTentWorkspace(root);
}
