import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";
import { createModuleDependencyRepositoryReader } from "../src/fs/module-dependencies.js";
import { extractRepositoryImports } from "../src/core/base/repository-imports.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const base = await fs.mkdtemp(path.join(scratch, "module-repository-"));
  t.after(() => fs.rm(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  const root = path.join(base, "project");
  await fs.mkdir(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      windowsHide: true,
      encoding: "utf8",
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
      ),
    }).trim();
  const write = async (file: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), text);
  };
  const commit = (message = "test: repository input") => {
    git("add", ".");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
      "-m",
      message,
    );
  };
  git("init", "--quiet", "--initial-branch=main");
  git("config", "core.autocrlf", "false");
  await write(".gitignore", ".tent/\nignored/\n");
  await write("src/main.ts", "import './a.js';\n");
  await write("src/a.ts", "export const a = 1;\n");
  commit();
  return { base, root, git, write, commit, reader: createModuleDependencyRepositoryReader(root) };
}

const paths = (
  input: Awaited<ReturnType<ReturnType<typeof createModuleDependencyRepositoryReader>>>,
) => input.sources.map((file) => file.path);

test("repository reader uses live nonignored members, source/config reading rules, and stable input references", async (t) => {
  const { root, write, git, reader } = await fixture(t);
  await write("ignored/hidden.ts", "import '../src/a.js';\n");
  await write("src/forced.ts", "export const hidden = 1;\n");
  git("add", "src/forced.ts");
  await write(".gitignore", ".tent/\nignored/\nsrc/forced.ts\n");
  await write(".tent/private.ts", "import '../src/a.js';\n");
  await write("test/entry.test.ts", "import '../src/a.js';\n");
  await write("src/theme.css", "body {}\n");
  await write("tsconfig.json", '{"compilerOptions":{"baseUrl":"."}}');
  const first = await reader();
  assert.equal(first.basis.head, git("rev-parse", "HEAD"));
  assert.equal(first.basis.dirty, true);
  assert.deepEqual(paths(first), [
    ".gitignore",
    "src/a.ts",
    "src/main.ts",
    "src/theme.css",
    "test/entry.test.ts",
    "tsconfig.json",
  ]);
  assert.equal(
    first.sources.find((file) => file.path === "test/entry.test.ts")!.content,
    undefined,
  );
  assert.equal(first.sources.find((file) => file.path === "src/theme.css")!.content, undefined);
  assert.equal(
    first.sources.find((file) => file.path === "tsconfig.json")!.content,
    '{"compilerOptions":{"baseUrl":"."}}',
  );
  assert.strictEqual((await reader()).sources, first.sources);
  assert.deepEqual(
    extractRepositoryImports(first.sources).edges.map((edge) => edge.to),
    ["src/a.ts"],
  );
  assert.ok(!(await fs.readdir(root)).some((file) => file.endsWith(".lock")));
});

test("continuous dirty edits, config edits, add/delete/rename and ignore changes invalidate the input", async (t) => {
  const { root, git, write, commit, reader } = await fixture(t);
  const clean = await reader();
  assert.equal(clean.basis.dirty, false);
  await write("src/main.ts", "import './b.js';\n");
  await write("src/b.ts", "export const b = 1;\n");
  const edited = await reader();
  assert.equal(edited.basis.dirty, true);
  assert.notStrictEqual(edited.sources, clean.sources);
  await write("src/main.ts", "import './a.js';\n");
  const editedAgain = await reader();
  assert.equal(editedAgain.basis.dirty, true);
  assert.equal(
    editedAgain.sources.find((file) => file.path === "src/main.ts")!.content,
    "import './a.js';\n",
  );
  assert.notStrictEqual(editedAgain.sources, edited.sources);
  await write("tsconfig.json", '{"compilerOptions":{"paths":{"alias":["src/a.ts"]}}}');
  const configOne = await reader();
  await write("tsconfig.json", '{"compilerOptions":{"paths":{"alias":["src/b.ts"]}}}');
  const configTwo = await reader();
  assert.notStrictEqual(configTwo.sources, configOne.sources);
  assert.match(configTwo.sources.find((file) => file.path === "tsconfig.json")!.content!, /src\/b/);
  await fs.rename(path.join(root, "src/b.ts"), path.join(root, "src/c.ts"));
  await fs.unlink(path.join(root, "src/a.ts"));
  const renamed = await reader();
  assert.ok(paths(renamed).includes("src/c.ts"));
  assert.ok(!paths(renamed).includes("src/b.ts") && !paths(renamed).includes("src/a.ts"));
  await write(".gitignore", ".tent/\nignored/\nsrc/c.ts\n");
  assert.ok(!paths(await reader()).includes("src/c.ts"));
  await write(".gitignore", ".tent/\nignored/\n");
  assert.ok(paths(await reader()).includes("src/c.ts"));
  commit();
  const committed = await reader();
  assert.notEqual(committed.basis.head, clean.basis.head);
  assert.equal(committed.basis.dirty, false);
  git("mv", "src/c.ts", "src/d.ts");
  const staged = await reader();
  assert.equal(staged.basis.dirty, true);
  assert.ok(paths(staged).includes("src/d.ts") && !paths(staged).includes("src/c.ts"));
});

test("Git config ignore updates and checkout identity changes are read anew", async (t) => {
  const { base, root, git, write, reader } = await fixture(t);
  await write("local.ts", "export const local = 1;\n");
  const externalIgnore = path.join(base, "excludes");
  await fs.writeFile(externalIgnore, "local.ts\n");
  assert.ok(paths(await reader()).includes("local.ts"));
  git("config", "core.excludesFile", externalIgnore);
  assert.ok(!paths(await reader()).includes("local.ts"));
  git("config", "--unset", "core.excludesFile");
  assert.ok(paths(await reader()).includes("local.ts"));
  await fs.writeFile(path.join(root, ".git/info/exclude"), "local.ts\n");
  assert.ok(!paths(await reader()).includes("local.ts"));
  await fs.writeFile(path.join(root, ".git/info/exclude"), "");
  assert.ok(paths(await reader()).includes("local.ts"));
  const old = (await reader()).basis.head;
  git("checkout", "--quiet", "--orphan", "other");
  assert.equal((await reader()).basis.head, null);
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--quiet",
    "-m",
    "test: new identity",
  );
  assert.notEqual((await reader()).basis.head, old);
});

test("nested Workspace basis ignores sibling edits while preserving project HEAD", async (t) => {
  const { root, git, write } = await fixture(t);
  const read = createModuleDependencyRepositoryReader(path.join(root, "src"));
  const clean = await read();
  assert.deepEqual(clean.basis, { head: git("rev-parse", "HEAD"), dirty: false });
  assert.deepEqual(paths(clean), ["a.ts", "main.ts"]);
  await write("sibling.ts", "export const outside = 1;\n");
  assert.equal((await read()).basis.dirty, false);
  await write("src/main.ts", "import './a.js'; // workspace edit\n");
  assert.equal((await read()).basis.dirty, true);
});

test("reader disables every configured clean/process filter, fsmonitor and inherited Git overrides without rewriting index", async (t) => {
  const { base, root, git, write, reader } = await fixture(t);
  const marker = path.join(base, "executed");
  const command = `node -e "require('node:fs').writeFileSync('${marker.replace(/\\/g, "/")}', 'unsafe'); process.exit(1)"`;
  await write("src/included.ts", "export const included = 1;\n");
  git("add", "src/included.ts");
  // Attribute names may contain dots; process-only definitions must also be disabled.
  git("config", "filter.one.clean", command);
  git("config", "filter.one.required", "true");
  git("config", "filter.two.process", command);
  git("config", "filter.two.required", "true");
  const included = path.join(base, "included-config");
  await fs.writeFile(
    included,
    `[filter "Three.Dot"]\n\tclean = ${command.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}\n\trequired = true\n`,
  );
  git("config", "include.path", included);
  await write("src/included.ts", "export const included = 2;\n");
  await write(
    ".gitattributes",
    "src/main.ts filter=one\nsrc/a.ts filter=two\nsrc/included.ts filter=Three.Dot\n",
  );
  git("config", "core.fsmonitor", command);
  await write("src/main.ts", "import './a.js'; // changed\n");
  await write("src/a.ts", "export const a = 2;\n");
  const index = path.join(root, ".git/index");
  const beforeBytes = await fs.readFile(index);
  const beforeStat = await fs.stat(index, { bigint: true });
  const original = childProcess.execFile;
  const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const mocked = t.mock.method(childProcess, "execFile", (...args: Parameters<typeof original>) => {
    const options = args[2] as { env?: NodeJS.ProcessEnv };
    calls.push({ args: args[1] as string[], env: options.env });
    return original(...args);
  });
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(base, "hostile.git");
  syncBuiltinESMExports();
  try {
    const input = await reader();
    assert.equal(input.basis.dirty, true);
    assert.equal(input.basis.head, git("rev-parse", "HEAD"));
    assert.ok(paths(input).includes("src/main.ts"));
    assert.ok(calls.length > 0);
    for (const call of calls) {
      assert.ok(call.args.includes("--no-optional-locks"));
      assert.ok(call.args.includes("--no-lazy-fetch"));
      assert.ok(call.args.includes("core.fsmonitor=false"));
      assert.ok(!Object.keys(call.env ?? {}).some((key) => key.toUpperCase().startsWith("GIT_")));
      assert.ok(!call.args.some((arg) => ["log", "checkout", "add", "hash-object"].includes(arg)));
    }
    const status = calls.find((call) => call.args.includes("status"))!.args;
    for (const filter of ["one", "two", "Three.Dot"])
      for (const option of ["clean=", "process=", "required=false"])
        assert.ok(status.includes(`filter.${filter}.${option}`));
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  await assert.rejects(fs.access(marker), { code: "ENOENT" });
  assert.deepEqual(await fs.readFile(index), beforeBytes);
  assert.equal((await fs.stat(index, { bigint: true })).mtimeNs, beforeStat.mtimeNs);
  await assert.rejects(fs.access(`${index}.lock`), { code: "ENOENT" });
});

test("symlink directory targets are excluded and source errors remain observable", async (t) => {
  const { base, root, write, reader } = await fixture(t);
  const outside = path.join(base, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "leak.ts"), "import 'secret';\n");
  await fs.symlink(outside, path.join(root, "linked"), "junction");
  assert.ok(!paths(await reader()).some((file) => file.startsWith("linked")));
  await write("src/error.ts", "export const x = 1;\n");
  const original = fs.readFile;
  const mocked = t.mock.method(fs, "readFile", (...args: Parameters<typeof original>) => {
    if (String(args[0]).endsWith("error.ts"))
      throw Object.assign(new Error("source denied"), { code: "EACCES" });
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(reader(), /error\.ts: source denied/);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.ok(paths(await reader()).includes("src/error.ts"));
});

test("non-Git rule-free workspaces have an absent baseline and unsupported ignore interpretation fails", async (t) => {
  const { root, write } = await fixture(t);
  await fs.rm(path.join(root, ".git"), { recursive: true });
  await fs.unlink(path.join(root, ".gitignore"));
  // Scratch fixtures live in this project's checkout: hide its ancestor Git
  // boundaries to exercise a genuinely non-Git Workspace without outside data.
  const original = fs.lstat;
  const mocked = t.mock.method(fs, "lstat", (...args: Parameters<typeof original>) => {
    if (path.basename(String(args[0])) === ".git")
      return Promise.reject(Object.assign(new Error("absent Git"), { code: "ENOENT" }));
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const reader = createModuleDependencyRepositoryReader(root);
    const input = await reader();
    assert.deepEqual(input.basis, { head: null, dirty: true });
    assert.deepEqual(paths(input), ["src/a.ts", "src/main.ts"]);
    await write(".gitignore", "src/a.ts\n");
    await assert.rejects(reader(), /缺少可信的忽略规则解释/);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test("non-Git Workspace borrows existing Tent Git ignore interpretation without writing it", async (t) => {
  const { root, git, write } = await fixture(t);
  await fs.rm(path.join(root, ".git"), { recursive: true });
  git("init", "--quiet", path.join(root, ".tent"));
  await write("ignored/hidden.ts", "export const hidden = 1;\n");
  await write("src/.gitignore", "a.ts\n");
  const tentGit = path.join(root, ".tent/.git");
  const original = fs.lstat;
  const mocked = t.mock.method(fs, "lstat", (...args: Parameters<typeof original>) => {
    const filename = String(args[0]);
    if (path.basename(filename) === ".git" && filename !== tentGit)
      return Promise.reject(Object.assign(new Error("absent Git"), { code: "ENOENT" }));
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const before = await fs.readdir(tentGit);
    const config = await fs.readFile(path.join(tentGit, "config"));
    const read = createModuleDependencyRepositoryReader(root);
    const input = await read();
    assert.deepEqual(input.basis, { head: null, dirty: true });
    assert.deepEqual(paths(input), [".gitignore", "src/.gitignore", "src/main.ts"]);
    assert.strictEqual((await read()).sources, input.sources);
    assert.deepEqual(await fs.readdir(tentGit), before);
    assert.deepEqual(await fs.readFile(path.join(tentGit, "config")), config);
    await assert.rejects(fs.access(path.join(tentGit, "tent-material-cache")), { code: "ENOENT" });
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test("nested repositories and submodules contribute no internal source files or dirty state", async (t) => {
  const { root, git, write, commit, reader } = await fixture(t);
  const nested = path.join(root, "nested");
  await write("nested/private.ts", "export const privateFile = 1;\n");
  git("init", "--quiet", nested);
  git("-C", nested, "add", "private.ts");
  git(
    "-C",
    nested,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--quiet",
    "-m",
    "test: nested repository",
  );
  commit("test: index gitlink");
  const clean = await reader();
  assert.equal(clean.basis.dirty, false);
  assert.ok(!paths(clean).some((file) => file.startsWith("nested/")));
  await write("nested/private.ts", "export const privateFile = 2;\n");
  const again = await reader();
  assert.equal(again.basis.dirty, false);
  assert.strictEqual(again.sources, clean.sources);
});
