#!/usr/bin/env node
// Explicit, reusable product-CLI fixtures. No automatic run, cleanup, or history fabrication.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

const marker = "bench-scale-fixture.json";
const schemaVersion = 3;
const metrics = ["load", "stopOne", "stopAll", "scan", "check", "cardList", "cardWatch"];
const help = `Tent product-CLI scale probe

generate --project-root ROOT --workspace NEW --cli FILE --scale 1|10 [--batch 90]
measure  --project-root ROOT --fixture SOURCE --workspace NEW --cli FILE
         [--label TEXT] [--repeats 5] [--output NEW.json]

All fixture, measurement and output paths must be inside ROOT/.scratch.
ROOT must be a Tent checkout. NEW must not exist. No overwrite or cleanup.
The CLI must already be built and is always explicit. No default operation.
Generation initializes an isolated project Git inside NEW before tent new;
the material baseline commit must never fall back to ROOT's repository.

1x = 6 top goals, 54 Nodes, 24 source files, 10 Cards and 5 Roles.
10x = 60 top goals, 540 Nodes, 240 source files, 100 Cards and 5 Roles.
Every top goal has 2 prompt children, 2 sub-goals and 4 output grandchildren.
Goals cover directories; half the outputs also cover a file. The first top
level goal covers the project root, including README/AGENTS/.gitignore.
Layout and 1024-byte ASCII bodies use seed 42. Node/Role/Card ids are fixed;
event times and event ids come from the actual CLI and are not fabricated.
Nodes are created with batched node create --draft. Cards use create/take/
return, with pending/consumed/returned/closed examples. History is produced
only by these real CLI operations in .tent/.git/history.sqlite; no fast-import,
old commit budget, direct database writes, or retired commands are used.

Generate once; reuse the untouched SOURCE for both builds. Each metric gets
its own fresh copy under NEW, preserving file times but excluding disposable
Tent caches and Stop state. Local materials use relocatable relative paths.
Each command is a fresh Node process: one cold sample then --repeats warm
samples (minimum 2). Cold means empty application caches, not flushed OS caches.
Stop changes one tracked source file or ALL tracked project files before EACH
sample, without priming Stop; its first sample compares against project HEAD.
Subsequent samples compare against the preceding successful Stop. Support
files in the all-dirty case retain their ignore rules; only a comment is added.
The load probe requests three explicit material paths. Other probes are
workspace scan/check and card list/watch for one Role with a pending Card.

Every invocation retains argv, stdin, full stdout/stderr, exit code, elapsed
milliseconds and machine observations. Results report cold samples and warm
medians, without the retired brief gates or automatic regression verdicts.
Use equivalent build formats, the same fixture/repeats, and a serial machine
window. SOURCE is fingerprinted before and after measurement; a failed sample
or changed CLI/fixture makes the run fail while retaining collected samples.

Examples (PowerShell; no implicit CLI selection):
  $root = (Get-Location).Path
  $bench = "$root/scripts/bench-scale.mjs"
  $cli = "$root/.worktrees/build-a/cli.mjs"
  node $bench generate --project-root $root --workspace "$root/.scratch/scale-1" --cli $cli --scale 1
  node $bench measure --project-root $root --fixture "$root/.scratch/scale-1" --workspace "$root/.scratch/scale-build-a" --cli $cli --label build-a --output "$root/.scratch/scale-build-a.json"
  # Repeat measure with a second explicit CLI, fresh workspace/output, same fixture.
`;

const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
);
const fail = (message) => {
  throw new Error(message);
};
function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
function integer(value, name, min = 1) {
  const n = Number(value);
  if (!/^\d+$/.test(value ?? "") || !Number.isSafeInteger(n) || n < min)
    fail(`${name} must be an integer >= ${min}`);
  return n;
}
function options(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!/^--[a-z-]+$/.test(key) || args[i + 1] === undefined || args[i + 1].startsWith("--"))
      fail(`Expected --option value, received ${key}`);
    if (Object.hasOwn(out, key.slice(2))) fail(`Duplicate option: ${key}`);
    out[key.slice(2)] = args[i + 1];
  }
  return out;
}
function scratchPath(root, value, name, fresh = false) {
  if (!value) fail(`--${name} is required`);
  const target = path.resolve(value);
  if (!inside(path.join(root, ".scratch"), target)) fail(`${name} must be inside ROOT/.scratch`);
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink() || !inside(root, fs.realpathSync(current)))
      fail(`${name} crosses a symbolic link/junction or project boundary`);
    if (current !== target && !stat.isDirectory()) fail(`${name} has a non-directory ancestor`);
    if (current === target && fresh) fail(`${name} already exists; choose a new path`);
  }
  return target;
}
function run(command, args, cwd, input) {
  const started = new Date().toISOString();
  const before = performance.now();
  const result = spawnSync(command, args, {
    cwd,
    env,
    input,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    command,
    args,
    cwd,
    stdin: input ?? null,
    started,
    milliseconds: performance.now() - before,
    code: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message ?? null,
  };
}
function checked(result, action) {
  if (result.error || result.code !== 0)
    fail(`${action} failed (${result.code}): ${result.error || result.stderr || result.stdout}`);
  return result.stdout.trim();
}
function git(ws, args) {
  const metadata = path.join(ws, ".git");
  if (!fs.lstatSync(metadata).isDirectory()) fail("Fixture must own an ordinary .git directory");
  return run(
    "git",
    [
      "--no-optional-locks",
      `--git-dir=${metadata}`,
      `--work-tree=${ws}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-c",
      "core.hooksPath=.bench-scale/empty-hooks",
      "-C",
      ws,
      ...args,
    ],
    ws,
  );
}
function tent(cli, ws, args, input) {
  return run(process.execPath, [cli, ...args, "--workspace", ws], ws, input);
}
function identity(cli, root) {
  const version = run(process.execPath, [cli, "version", "--json", "--workspace", root], root);
  return {
    path: cli,
    sha256: createHash("sha256").update(fs.readFileSync(cli)).digest("hex"),
    version: JSON.parse(checked(version, "CLI version")),
  };
}
function machine() {
  const cpus = os.cpus();
  return {
    at: new Date().toISOString(),
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    node: process.version,
    cpuModel: cpus[0]?.model,
    cpuCount: cpus.length,
    cpuTimes: cpus.map((c) => c.times),
    totalMemory: os.totalmem(),
    freeMemory: os.freemem(),
    loadAverage: os.loadavg(),
    note: "Windows loadavg is always zero; CPU counters include all machine activity",
  };
}
function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}
const disposable = (rel) =>
  rel === ".bench-scale" ||
  rel === marker ||
  rel === ".tent/temp" ||
  rel.startsWith(".tent/temp/") ||
  /^\.tent\/\.git\/tent-/.test(rel) ||
  rel === ".tent/.git/history.sqlite-shm";
function entries(root) {
  const found = [];
  function walk(dir, rel = "") {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const name = rel ? rel + "/" + entry.name : entry.name;
      if (disposable(name)) continue;
      if (entry.isSymbolicLink()) fail(`Fixture contains a symbolic link/junction: ${name}`);
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        found.push({ rel: name, directory: true });
        walk(file, name);
      } else if (entry.isFile()) found.push({ rel: name, directory: false });
      else fail(`Fixture contains a non-regular entry: ${name}`);
    }
  }
  walk(root);
  return found;
}
function fingerprint(root) {
  const h = createHash("sha256");
  for (const e of entries(root)) {
    h.update(JSON.stringify([e.rel, e.directory]) + "\n");
    if (!e.directory) {
      const b = fs.readFileSync(path.join(root, e.rel));
      h.update(String(b.length) + ":");
      h.update(b);
    }
  }
  return h.digest("hex");
}
function copyFixture(source, dest) {
  fs.mkdirSync(dest); // The caller already rejected every existing target.
  for (const e of entries(source)) {
    const from = path.join(source, e.rel),
      to = path.join(dest, e.rel);
    if (e.directory) fs.mkdirSync(to);
    else {
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      const stat = fs.statSync(from);
      fs.utimesSync(to, stat.atime, stat.mtime);
    }
  }
}
function generate(root, ws, cli, opts, build) {
  const scale = integer(opts.scale, "scale");
  if (![1, 10].includes(scale)) fail("--scale must be 1 or 10");
  const batch = integer(opts.batch ?? "90", "batch");
  if (batch % 9 !== 0) fail("--batch must be a multiple of 9 to retain each subtree in one batch");
  const goals = 6 * scale,
    cards = 10 * scale;
  let seed = 42;
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  function body() {
    let b = "";
    while (b.length < 1024)
      b += `Purpose, constraint and observed evidence ${Math.floor(rand() * 1e6)}.\n`;
    return b.slice(0, 1024);
  }
  fs.mkdirSync(path.dirname(ws), { recursive: true });
  fs.mkdirSync(ws);
  // ROOT/.scratch is inside the outer project: `tent new` would reuse that Git.
  // Create an isolated project repository before invoking any CLI or baseline write.
  const repository = run("git", ["init", "--quiet", ws], ws);
  checked(repository, "fixture git init");
  const boundary = run(
    "git",
    ["--no-optional-locks", "-C", ws, "rev-parse", "--show-toplevel"],
    ws,
  );
  if (fs.realpathSync(checked(boundary, "fixture Git root")) !== fs.realpathSync(ws))
    fail("Fixture Git root is not the requested workspace");
  const creation = run(process.execPath, [cli, "new", ws, "--workspace", ws], root);
  checked(creation, "CLI new");
  fs.mkdirSync(path.join(ws, ".bench-scale/empty-hooks"), { recursive: true });
  const log = path.join(ws, ".bench-scale/generation.jsonl");
  const record = (phase, result) => {
    fs.appendFileSync(log, JSON.stringify({ phase, ...result }) + "\n");
    checked(result, phase);
    return result;
  };
  record("project init", repository);
  record("project boundary", boundary);
  record("new", creation);
  const projectFiles = [".gitignore", "AGENTS.md", "README.md"];
  fs.writeFileSync(path.join(ws, ".gitignore"), "/bench-scale-fixture.json\n/.bench-scale/\n", {
    flag: "wx",
  });
  fs.writeFileSync(
    path.join(ws, "README.md"),
    "# Scale fixture\n\nStatic material for product-CLI measurements.\n",
    { flag: "wx" },
  );
  fs.writeFileSync(
    path.join(ws, "AGENTS.md"),
    "# Fixture conventions\n\nKeep public behaviour stable.\n",
    { flag: "wx" },
  );
  const items = [],
    goalIds = [];
  const add = (ref, name, type, parent, resource) => {
    const id = `node-${(items.length + 1).toString(36).padStart(6, "0")}`;
    items.push({
      op: "create",
      ref,
      id,
      name,
      type,
      body: body(),
      ...(parent ? { parent } : {}),
      ...(resource ? { resource } : {}),
      tags: [type === "goal" ? "requirement" : type === "prompt" ? "decision" : "evidence"],
    });
    return id;
  };
  for (let g = 0; g < goals; g++) {
    goalIds.push(add(`g${g}`, `Goal${g}`, "goal", null, g === 0 ? "./" : `./src/g${g}/`));
    for (let p = 0; p < 2; p++) add(`g${g}p${p}`, `Decision${p}`, "prompt", `@g${g}`);
    for (let s = 0; s < 2; s++) {
      add(`g${g}s${s}`, `Sub${s}`, "goal", `@g${g}`, `./src/g${g}/sub${s}/`);
      for (let o = 0; o < 2; o++) {
        const relative = `src/g${g}/sub${s}/f${o}.ts`;
        fs.mkdirSync(path.dirname(path.join(ws, relative)), { recursive: true });
        fs.writeFileSync(
          path.join(ws, relative),
          `export const value = ${Math.floor(rand() * 1e6)};\n`,
          { flag: "wx" },
        );
        projectFiles.push(relative);
        add(
          `g${g}s${s}o${o}`,
          `Result${o}`,
          "output",
          `@g${g}s${s}`,
          o === 0 ? "./" + relative : undefined,
        );
      }
    }
  }
  record("project add", git(ws, ["add", "--all"]));
  record(
    "project commit",
    git(ws, [
      "-c",
      "user.name=Scale probe",
      "-c",
      "user.email=scale@local.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "Create static scale materials",
    ]),
  );
  for (let start = 0; start < items.length; start += batch) {
    const draft = path.join(ws, ".bench-scale", `batch-${start}.json`);
    writeJson(draft, { items: items.slice(start, start + batch) });
    record("node create --draft", tent(cli, ws, ["node", "create", "--draft", draft, "--json"]));
    if (fs.existsSync(draft)) fail("CLI did not consume the completed draft");
  }
  const roles = [];
  for (let r = 0; r < 5; r++) {
    const id = `role-${r.toString(36).padStart(6, "0")}`;
    record(
      "role create",
      tent(cli, ws, [
        "role",
        "create",
        "--id",
        id,
        "--title",
        `Role${r}`,
        "--body",
        body(),
        "--json",
      ]),
    );
    roles.push(id);
  }
  const states = { pending: 0, consumed: 0, returned: 0, closed: 0 };
  for (let c = 0; c < cards; c++) {
    const id = `card-${c.toString(36).padStart(8, "0")}`,
      target = roles[1 + (c % 4)];
    record(
      "card create",
      tent(
        cli,
        ws,
        [
          "card",
          "create",
          "--id",
          id,
          "--title",
          `Task${c}`,
          "--prompt",
          "-",
          "--source",
          goalIds[c % goals],
          "--target",
          target,
          "--return-to",
          roles[0],
          "--json",
        ],
        body(),
      ),
    );
    if (c % 5 === 0) {
      states.pending++;
      continue;
    }
    record("card take", tent(cli, ws, ["card", "take", id, "--role", target, "--json"]));
    if (c % 5 === 1 || c % 5 === 4) {
      states.consumed++;
      continue;
    }
    record(
      "card return",
      tent(cli, ws, [
        "card",
        "return",
        id,
        "--role",
        target,
        "--result",
        `Observed result ${c}`,
        "--json",
      ]),
    );
    if (c % 5 === 2) {
      states.returned++;
      continue;
    }
    record("card close", tent(cli, ws, ["card", "take", id, "--role", roles[0], "--json"]));
    states.closed++;
  }
  const status = checked(git(ws, ["status", "--porcelain"]), "project status");
  if (status) fail(`Generated fixture is not clean: ${status}`);
  if (!fs.existsSync(path.join(ws, ".tent/.git/history.sqlite")))
    fail("CLI did not create SQLite history");
  const fixture = {
    schemaVersion,
    kind: "tent-cli-scale-fixture",
    workspace: ws,
    seed: 42,
    bodyBytes: 1024,
    scale,
    goals,
    nodes: items.length,
    cards,
    cardStates: states,
    roles,
    benchmarkRole: roles[1],
    batch,
    projectFiles: projectFiles.sort(),
    sourceFiles: projectFiles.filter((f) => f.endsWith(".ts")).sort(),
    loadPaths: [
      `src/g0/sub0/f0.ts`,
      `src/g${Math.floor(goals / 2)}/sub1/f1.ts`,
      `src/g${goals - 1}/sub0/f1.ts`,
    ],
    projectHead: checked(git(ws, ["rev-parse", "HEAD"]), "project HEAD"),
    cli: build,
    historyBytes: fs.statSync(path.join(ws, ".tent/.git/history.sqlite")).size,
    mutationCounts: {
      nodeBatches: Math.ceil(items.length / batch),
      roles: 5,
      cardCreates: cards,
      cardTakes: cards - states.pending,
      cardReturns: states.returned + states.closed,
      cardCloses: states.closed,
    },
    fingerprint: fingerprint(ws),
    generationLog: ".bench-scale/generation.jsonl",
  };
  writeJson(path.join(ws, marker), fixture);
  return fixture;
}
function median(values) {
  const a = [...values].sort((a, b) => a - b),
    i = Math.floor(a.length / 2);
  return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2;
}
function measure(root, ws, cli, opts, build) {
  const repeats = integer(opts.repeats ?? "5", "repeats", 2);
  const source = scratchPath(root, opts.fixture, "fixture");
  if (source === ws || inside(source, ws) || inside(ws, source))
    fail("Fixture and workspace must not contain each other");
  const output = opts.output ? scratchPath(root, opts.output, "output", true) : null;
  if (
    output &&
    (inside(source, output) || inside(ws, output) || output === ws || output === source)
  )
    fail("Output must be outside fixture and measurement workspace");
  const fixture = JSON.parse(fs.readFileSync(path.join(source, marker), "utf8"));
  if (fixture.kind !== "tent-cli-scale-fixture" || fixture.schemaVersion !== schemaVersion)
    fail("Unsupported fixture marker; generate with this script");
  if (fingerprint(source) !== fixture.fingerprint) fail("Source fixture changed since generation");
  if (
    !fs.lstatSync(path.join(source, ".git")).isDirectory() ||
    fs.realpathSync(checked(git(source, ["rev-parse", "--show-toplevel"]), "fixture Git root")) !==
      fs.realpathSync(source)
  )
    fail("Fixture must contain its own ordinary Git checkout");
  if (![1, 10].includes(fixture.scale)) fail("Invalid fixture scale");
  // All mutation targets are generated, fixed-format relative paths, never marker-supplied arbitrary paths.
  const expectedFiles = [".gitignore", "AGENTS.md", "README.md"];
  for (let g = 0; g < 6 * fixture.scale; g++)
    for (let s = 0; s < 2; s++)
      for (let o = 0; o < 2; o++) expectedFiles.push(`src/g${g}/sub${s}/f${o}.ts`);
  expectedFiles.sort();
  if (JSON.stringify(expectedFiles) !== JSON.stringify(fixture.projectFiles))
    fail("Invalid fixture file layout");
  const sourceFiles = expectedFiles.filter((f) => f.endsWith(".ts"));
  const loadPaths = [
    "src/g0/sub0/f0.ts",
    `src/g${Math.floor((6 * fixture.scale) / 2)}/sub1/f1.ts`,
    `src/g${6 * fixture.scale - 1}/sub0/f1.ts`,
  ];
  if (fixture.benchmarkRole !== "role-000001") fail("Invalid fixture benchmark Role");
  fs.mkdirSync(path.dirname(ws), { recursive: true });
  fs.mkdirSync(ws); // No cleanup or reuse of a previous run.
  const samples = [],
    before = machine();
  const log = path.join(ws, "samples.jsonl");
  let error = null;
  try {
    for (const metric of metrics) {
      const target = path.join(ws, metric);
      copyFixture(source, target);
      const originals = new Map(
        expectedFiles.map((f) => [f, fs.readFileSync(path.join(target, f), "utf8")]),
      );
      for (let i = 0; i <= repeats; i++) {
        const phase = i === 0 ? "cold" : "warm";
        const dirty =
          metric === "stopOne" ? [sourceFiles[0]] : metric === "stopAll" ? expectedFiles : [];
        for (const f of dirty) {
          const comment =
            f === ".gitignore"
              ? `# scale sample ${i}`
              : f.endsWith(".md")
                ? `<!-- scale sample ${i} -->`
                : `// scale sample ${i}`;
          fs.writeFileSync(path.join(target, f), originals.get(f) + "\n" + comment + "\n");
        }
        const args =
          metric === "load"
            ? ["load", ...loadPaths, "--json"]
            : metric.startsWith("stop")
              ? ["hook", "stop", "--host", "codex"]
              : metric === "scan" || metric === "check"
                ? ["workspace", metric, "--json"]
                : metric === "cardList"
                  ? ["card", "list", "--role", fixture.benchmarkRole, "--json"]
                  : ["card", "watch", "--role", fixture.benchmarkRole, "--timeout", "0", "--json"];
        const input = metric.startsWith("stop")
          ? JSON.stringify({ hook_event_name: "Stop", cwd: target, stop_hook_active: false })
          : undefined;
        const observation = {
          freeMemory: os.freemem(),
          cpuTimes: os.cpus().map((c) => c.times),
          loadAverage: os.loadavg(),
        };
        const sample = {
          metric,
          phase,
          iteration: i,
          dirtyFiles: dirty.length,
          observation,
          ...tent(cli, target, args, input),
        };
        sample.validationError = null;
        try {
          checked(sample, metric);
          const value = JSON.parse(sample.stdout);
          if (
            metric.startsWith("stop") &&
            (value.decision !== "block" || typeof value.reason !== "string")
          )
            fail(`${metric} did not deliver a changed-file reminder`);
        } catch (e) {
          sample.validationError = e.message;
        }
        samples.push(sample);
        fs.appendFileSync(log, JSON.stringify(sample) + "\n"); // Preserve failed invocations too.
        if (sample.validationError) fail(sample.validationError);
      }
    }
  } catch (e) {
    error = e.message;
  }
  const cliHashAfter = createHash("sha256").update(fs.readFileSync(cli)).digest("hex");
  if (cliHashAfter !== build.sha256) error = "CLI artifact changed during measurement";
  if (fingerprint(source) !== fixture.fingerprint)
    error = "Source fixture changed during measurement";
  const result = {
    schemaVersion,
    kind: "tent-cli-scale-measurement",
    label: opts.label ?? null,
    workspace: ws,
    sourceFixture: source,
    fixture,
    cli: build,
    repeats,
    machineBefore: before,
    machineAfter: machine(),
    error,
    cliHashAfter,
    samples,
    summary: Object.fromEntries(
      metrics.map((metric) => {
        const rows = samples.filter((s) => s.metric === metric),
          warm = rows
            .filter((s) => s.phase === "warm" && s.code === 0 && !s.error && !s.validationError)
            .map((s) => s.milliseconds);
        return [
          metric,
          {
            coldMilliseconds: rows.find((s) => s.phase === "cold")?.milliseconds ?? null,
            warmSamples: warm.length,
            warmMedianMilliseconds: warm.length ? median(warm) : null,
            complete: warm.length === repeats,
          },
        ];
      }),
    ),
    interpretation:
      "Fresh product-CLI subprocess wall times; setup/copy/mutation excluded. Cold application caches, OS cache unchanged. No automatic gate or causal noise correction.",
  };
  if (output) writeJson(output, result);
  return result;
}
try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--help" || command === "help") process.stdout.write(help);
  else {
    if (!["generate", "measure"].includes(command)) fail("Choose generate or measure; use --help");
    const opts = options(args);
    const allowed =
      command === "generate" ? ["scale", "batch"] : ["fixture", "label", "repeats", "output"];
    for (const key of Object.keys(opts))
      if (!["project-root", "workspace", "cli", ...allowed].includes(key))
        fail(`Unknown option --${key}`);
    if (!opts["project-root"]) fail("--project-root is required");
    const root = fs.realpathSync(path.resolve(opts["project-root"]));
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    if (pkg.name !== "vibe-tent" || !fs.existsSync(path.join(root, ".git")))
      fail("ROOT must be a Tent checkout");
    const ws = scratchPath(root, opts.workspace, "workspace", true);
    if (!opts.cli) fail("--cli is required");
    const cli = fs.realpathSync(path.resolve(opts.cli));
    if (!fs.statSync(cli).isFile()) fail("--cli must be a built CLI file");
    const build = identity(cli, root);
    const result =
      command === "generate"
        ? generate(root, ws, cli, opts, build)
        : measure(root, ws, cli, opts, build);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (result.error) process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`bench-scale: ${error.message}\n`);
  process.exitCode = 1;
}
