import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { testScratchRoot } from "./scratch.js";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { TestContext } from "node:test";
import type { NodeFs } from "../src/fs/node-fs.js";
import { withFileMutationLock } from "../src/fs/mutation-lock.js";

/** Test serialization/CAS under slow Git I/O; production lock deadlines have separate tests. */
export function extendTestLockWait(t: TestContext, adapter: NodeFs, systemRoot: string): void {
  t.mock.method(adapter, "withLock", <T>(lockPath: string, action: () => Promise<T>) =>
    withFileMutationLock(
      path.join(systemRoot, lockPath),
      async () =>
        (await adapter.exists(".git")) ? adapter.history.withCaptureScope(action) : action(),
      {
        waitMs: 60_000,
        busyMessage: "Test writer did not release the mutation lock within 60 seconds",
        acquireFailedMessage: "Cannot acquire the test mutation lock",
      },
    ),
  );
}

export async function makeTent(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(testScratchRoot(), "tent-"));
  const box = (relativePath: string, frontmatter: string, body = "") => {
    const folderName = relativePath.split("/").pop() || relativePath;
    return fs
      .mkdir(path.join(dir, relativePath), { recursive: true })
      .then(() =>
        fs.writeFile(
          path.join(dir, relativePath, `${folderName}.md`),
          `---\n${frontmatter}\n---\n${body}\n`,
        ),
      );
  };
  // System root marker: CLI must locate index.md and must not fall back to cwd.
  await fs.writeFile(path.join(dir, "index.md"), '---\nokf_version: "0.2"\n---\n# Index\n');
  await box("goal", "id: node-goalzone\ntype: goal");
  await box("goal/挖新alpha", "id: node-g1\ntype: goal");
  await box("goal/挖新alpha/写表达式", "id: node-g2\ntype: goal");
  await box("prompt", "id: node-promptzone\ntype: prompt");
  await box("prompt/表达式任务书", "id: node-p1\ntype: prompt", "给 executor 的任务");
  await box("prompt/表达式任务书/草稿", "id: node-p2\ntype: prompt");
  await box("output", "id: node-outzone\ntype: output");
  await box("output/alpha仓库指针", "id: node-o1\ntype: output");
  await fs.mkdir(path.join(dir, "temp"), { recursive: true });
  await box("prompt/旧站资料", "id: node-a1\ntype: prompt-asset");
  return dir;
}

export function git(dir: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "The Tent Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "The Tent Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
      },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `git ${args.join(" ")} exit ${code}`));
    });
  });
}

export function cli(
  dir: string,
  ...args: string[]
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const tsxLoader = path.join(process.cwd(), "node_modules", "tsx", "dist", "loader.mjs");
    const cliPath = path.join(process.cwd(), "src", "cli", "tent.ts");
    const child = spawn(
      process.execPath,
      ["--import", pathToFileURL(tsxLoader).href, cliPath, ...args],
      {
        cwd: dir,
        env: {
          ...process.env,
          TENT_HOME: path.join(dir, ".tent-test-home"),
          TENT_SERVICE_DATA_DIR: path.join(dir, ".tent-test-home", "no-service"),
        },
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export async function configureTestGitIdentity(dir: string): Promise<void> {
  await git(dir, "config", "user.name", "The Tent Test");
  await git(dir, "config", "user.email", "test@example.invalid");
}
