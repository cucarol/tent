import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { testScratchRoot } from "./scratch.js";
import { removeTestFixture } from "./node-fs.js";

const run = promisify(execFile);

async function guardedEntry(t: TestContext, pattern: string) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "cli-lazy-entry-"));
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  const guard = path.join(root, "guard.mjs"),
    preload = path.join(root, "preload.mjs");
  await fs.writeFile(
    guard,
    `export async function resolve(specifier, context, next) {
    const resolved = await next(specifier, context);
    if (new RegExp(${JSON.stringify(pattern)}).test(new URL(resolved.url).pathname))
      throw new Error("Unexpected heavy entry import: " + resolved.url);
    return resolved;
  }`,
  );
  await fs.writeFile(
    preload,
    `import {register} from 'node:module'; register(${JSON.stringify(pathToFileURL(guard).href)}, import.meta.url);`,
  );
  return (args: string[]) =>
    run(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), "--import", pathToFileURL(preload).href, ...args],
      { windowsHide: true, timeout: 20_000 },
    );
}

test("version, top-level help and unknown commands do not initialize document or command modules", async (t) => {
  const guarded = await guardedEntry(
    t,
    String.raw`/src/(?:fs/|core/(?:graph|store|write|read|check)/|cli/(?:node-commands|card-commands|role-commands|workspace-commands|hook)\.)`,
  );
  const launch = (args: string[]) => guarded([path.resolve("src/cli/tent.ts"), ...args]);
  const version = await launch(["version", "--json"]);
  assert.match(JSON.parse(version.stdout).version, /^\d+\.\d+\.\d+/);
  assert.match(
    (await launch(["--help"])).stdout,
    /^Tent keeps the context of your project's agent sessions/,
  );
  await assert.rejects(launch(["not-a-command"]), (error: unknown) => {
    const result = error as { stderr?: string };
    assert.match(result.stderr ?? "", /Unknown command: tent not-a-command/);
    assert.doesNotMatch(result.stderr ?? "", /Unexpected heavy entry import/);
    return true;
  });
});

test("importing the Node command entry does not initialize mutations or filesystem adapters", async (t) => {
  const launch = await guardedEntry(
    t,
    String.raw`/src/(?:core/write/|core/graph/(?:ops|node-output|node-document-write)\.|fs/(?:node-fs|node-draft-consumption)\.)`,
  );
  const result = await launch([
    "--input-type=module",
    "-e",
    `const command = await import(${JSON.stringify(pathToFileURL(path.resolve("src/cli/node-commands.ts")).href)}); console.log(typeof command.runNodeCommand);`,
  ]);
  assert.equal(result.stdout.trim(), "function");
});
