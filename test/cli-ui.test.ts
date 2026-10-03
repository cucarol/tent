import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { runUiCommand } from "../src/cli/ui-command.js";
import { initializeTentWorkspace } from "../src/fs/workspace-init.js";
import { defaultWorkspacesFile, readWorkspaces } from "../src/ui-server/workspaces.js";
import { testScratchRoot } from "./scratch.js";

test("UI command selects the workspace and package assets and closes once on Ctrl+C", async (t) => {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "cli-ui-"));
  t.after(async () => {
    assert.equal(path.dirname(workspace), path.resolve(testScratchRoot()));
    await fs.rm(workspace, { recursive: true, force: true });
  });
  await initializeTentWorkspace(workspace);
  const signals = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  let closed = 0;
  const server = await runUiCommand(["--workspace", workspace, "--port", "0", "--no-open"], {
    packageRoot: process.cwd(),
    startServer: async (options) => {
      assert.equal(options.workspaceRoot, workspace);
      assert.equal(options.port, 0);
      assert.equal(options.staticDir, path.join(process.cwd(), "ui-dist"));
      assert.equal(options.workspacesFile, defaultWorkspacesFile());
      return {
        url: "http://127.0.0.1:12345/#token=test",
        close: async () => {
          closed++;
        },
      };
    },
  });
  t.after(() => server!.close());
  process.emit("SIGINT");
  await server!.close();
  assert.equal(closed, 1);
  assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], signals);
});

test("UI rejects invalid arguments before starting a service", async () => {
  const options = {
    packageRoot: process.cwd(),
    startServer: async () => {
      throw new Error("must not start");
    },
  };
  for (const port of ["", "-1", "NaN", "65536", "1.5"])
    await assert.rejects(() => runUiCommand([`--port=${port}`], options), /--port must/);
  await assert.rejects(() => runUiCommand(["--unknown"], options), /Unknown option/);
});

test("CLI ui dispatch starts a real loopback service for the selected workspace", async (t) => {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "cli-ui-dispatch-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await initializeTentWorkspace(workspace);
  const userDir = path.join(workspace, "test-user");
  const env = {
    ...process.env,
    APPDATA: path.join(userDir, "AppData", "Roaming"),
    XDG_STATE_HOME: path.join(userDir, ".local", "state"),
    HOME: userDir,
    USERPROFILE: userDir,
  };
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/cli/tent.ts",
      "ui",
      "--workspace",
      workspace,
      "--port",
      "0",
      "--no-open",
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env },
  );
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await closed;
  });
  const url = await new Promise<URL>((resolve, reject) => {
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => reject(new Error(`UI startup timed out: ${stderr}`)), 20_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", () => {
      clearTimeout(timer);
      reject(new Error(`UI exited before startup: ${stderr}`));
    });
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.stdout.on("data", (data) => {
      stdout += String(data);
      const match = /^http:\/\/127\.0\.0\.1:\d+\/#token=[\w-]+$/m.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolve(new URL(match[0]));
      }
    });
  });
  const response = await fetch(new URL("/api/revision", url), {
    headers: { Authorization: `Bearer ${url.hash.slice(7)}` },
  });
  assert.equal(response.status, 200);
  assert.match(((await response.json()) as { revision: string }).revision, /^[a-f0-9]{64}$/);
  const remembered = await readWorkspaces(defaultWorkspacesFile(env, process.platform, userDir));
  assert.equal(remembered.length, 1);
  assert.equal(remembered[0]!.root, workspace);
});
