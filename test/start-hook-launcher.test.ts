import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { removeTestFixture } from "./node-fs.js";
import { testScratchRoot } from "./scratch.js";

test("both SessionStart launchers use the local start runtime with the CLI absent", async (t) => {
  const fixture = await fs.mkdtemp(path.join(testScratchRoot(), "start-launcher-"));
  t.after(() => removeTestFixture(fixture, { recursive: true, force: true }));
  for (const host of ["codex", "claude-code"]) {
    const bundle = path.join(fixture, host, "package with spaces");
    const launcher = path.join(bundle, "hooks/session.mjs");
    await fs.mkdir(path.dirname(launcher), { recursive: true });
    await fs.copyFile(path.resolve("plugins", host, "tent/hooks/session.mjs"), launcher);
    await fs.writeFile(
      path.join(bundle, "start-hook.mjs"),
      `import assert from "node:assert/strict";
import path from "node:path";
export async function runHookCommand(sub, args, options) {
  assert.equal(sub, "start");
  assert.deepEqual(args, ["--host", ${JSON.stringify(host)}]);
  assert.equal(path.resolve(options.packageRoot), ${JSON.stringify(bundle)});
  let input = "";
  for await (const chunk of process.stdin) input += chunk.toString();
  return { stdout: input };
}
`,
    );
    const input = JSON.stringify({ hook_event_name: "SessionStart", cwd: fixture }) + "\n";
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        ["-e", `import(${JSON.stringify(pathToFileURL(launcher).href)})`, "--", "start"],
        { cwd: fixture, windowsHide: true, timeout: 10_000 },
        (error, stdout, stderr) =>
          error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout),
      );
      child.stdin!.end(input);
    });
    assert.equal(output, input);
  }
});
