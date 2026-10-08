#!/usr/bin/env node
// Product-CLI scale probe. No default run, downloads, or cleanup operations.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const help = `Tent product-CLI scale probe

generate --project-root ROOT --workspace NEW --cli FILE
         (--scale 1|10 | --goals N --commits N --cards N) [--batch 90]
measure  --project-root ROOT --fixture SOURCE --workspace NEW --cli FILE
         [--label TEXT] [--repeats 2] [--output NEW.json]

All fixture, measurement and output paths must be inside ROOT/.scratch.
ROOT must be a Tent checkout. NEW must not exist; no overwrite or cleanup.
The CLI must already be built. No command runs implicitly or selects a CLI.

1x = 6 top goals, 54 Nodes, exactly 438 retained commits, 10 Cards.
10x = 60 top goals, 540 Nodes, exactly 4380 retained commits, 100 Cards.
Each top goal has 2 prompt decisions, 2 sub-goals and 4 outputs; every Node
starts with 1024 ASCII body bytes. Half the outputs reference local material
via file: URI, accepted by both e8165b20 and current CLI. Seed is fixed at 42.
The real CLI creates Nodes in batches and records Core material/goal baselines.
Synthetic Node edits and Card create/take history use Git fast-import; 80% of
Cards are consumed. These fixtures are scale probes, not mutation correctness
tests. The final commit budget counts the actual create/take operations.

measure copies exactly one explicit generated fixture to a new workspace,
excluding disposable history/derived caches. Source material file: URIs still
point into SOURCE, which must remain present and unchanged. Both CLI versions
therefore see identical retained history, source pins and material contents.
Sequence: fresh-process brief (empty derived caches); prime card list; then
each repeat appends the same body to the first top goal, measures the first
brief after that write, two hot briefs and two card lists. Each command is a
new Node subprocess. Cold means application caches, not flushed OS caches.
No UI snapshot or in-process Core substitute is used for the three CLI gates.

Examples (PowerShell; paths are explicit):
  $root = '${path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..").replaceAll("\\", "/")}'
  $bench = "$root/scripts/bench-scale.mjs"
  $old = "$root/.scratch/scale-old-build/cli.mjs" # built from e8165b20
  $new = "$root/cli.mjs" # build intended candidate before measuring
  node $bench generate --project-root $root --workspace "$root/.scratch/scale-1" --cli $old --scale 1
  node $bench generate --project-root $root --workspace "$root/.scratch/scale-10" --cli $old --scale 10
  # Back-to-back, same fixture and sequence. Use fresh names for another run.
  node $bench measure --project-root $root --fixture "$root/.scratch/scale-10" --workspace "$root/.scratch/scale-old-run" --cli $old --label e8165b20 --output "$root/.scratch/scale-old.json"
  node $bench measure --project-root $root --fixture "$root/.scratch/scale-10" --workspace "$root/.scratch/scale-new-run" --cli $new --label candidate --output "$root/.scratch/scale-new.json"
  # Small script smoke only (not the 10x performance gate):
  node $bench generate --project-root $root --workspace "$root/.scratch/scale-smoke" --cli $new --goals 1 --commits 24 --cards 2

JSON records CLI version/hash/source Git identity, machine/load/CPU observations,
cache bytes, subprocess results and gate observations. The 10x limits from
2026-10-06 are first brief <=13.5s, hot brief <=7.9s, card list <=2.2s.
Only successful measured samples at exactly 10x receive gate observations.
Compare old-build results to the published baseline to judge machine noise;
the script neither corrects for noise nor declares independent acceptance.
`;

const marker = "bench-scale-fixture.json";
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
);
function fail(message) {
  throw new Error(message);
}
function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel);
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
  // Check every existing component, including dangling links and junctions.
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
  const before = performance.now();
  const result = spawnSync(command, args, {
    cwd,
    env,
    input,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    seconds: (performance.now() - before) / 1000,
    code: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
function checked(result, action) {
  if (result.code !== 0)
    fail(`${action} failed (${result.code}): ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
function git(ws, args, input) {
  return checked(
    run("git", ["-C", path.join(ws, ".tent"), "-c", "core.autocrlf=false", ...args], ws, input),
    `git ${args[0]}`,
  );
}
function identity(cli, root) {
  const dir = path.dirname(cli);
  const optionalGit = (args) => {
    const value = run("git", ["-C", dir, ...args], root);
    return value.code === 0 ? value.stdout.trim() : null;
  };
  return {
    path: cli,
    sha256: createHash("sha256").update(fs.readFileSync(cli)).digest("hex"),
    version: checked(run(process.execPath, [cli, "--version"], root), "CLI --version"),
    sourceHead: optionalGit(["rev-parse", "HEAD"]),
    sourceStatus: optionalGit(["status", "--porcelain"]),
  };
}
function tent(cli, ws, args, input) {
  return run(process.execPath, [cli, ...args, "--workspace", ws], ws, input);
}
function collectDocs(tentRoot) {
  const docs = [];
  function walk(dir) {
    for (const e of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if ([".git", "roles", "cards", "temp", "attachments"].includes(e.name)) continue;
      const file = path.join(dir, e.name);
      if (e.isDirectory()) walk(file);
      else if (e.name === `${path.basename(dir)}.md`) {
        const raw = fs.readFileSync(file, "utf8");
        const id = /^id: (node-[a-z0-9]+)$/m.exec(raw)?.[1];
        const type = /^type: (\S+)$/m.exec(raw)?.[1];
        if (id)
          docs.push({
            id,
            type,
            rel: path.relative(tentRoot, file).split(path.sep).join("/"),
            raw,
          });
      }
    }
  }
  walk(tentRoot);
  return docs;
}
function generate(root, ws, cli, opts, build) {
  const hasScale = opts.scale !== undefined;
  if (hasScale && ["goals", "commits", "cards"].some((key) => opts[key] !== undefined))
    fail("Use --scale OR --goals/--commits/--cards");
  const scale = hasScale ? integer(opts.scale, "scale") : null;
  if (hasScale && ![1, 10].includes(scale)) fail("--scale must be 1 or 10");
  const goals = hasScale ? 6 * scale : integer(opts.goals, "goals");
  const totalCommits = hasScale ? 438 * scale : integer(opts.commits, "commits");
  const cardCount = hasScale ? 10 * scale : integer(opts.cards, "cards", 0);
  const batch = integer(opts.batch ?? "90", "batch");
  if (batch % 9 !== 0)
    fail("--batch must be a multiple of 9 so each goal's references share a batch");
  let seed = 42;
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const body = () => {
    let text = "";
    while (text.length < 1024)
      text += `Agreed behaviour, reason and supporting evidence ${Math.floor(rand() * 1e6)}.\n`;
    return text.slice(0, 1024);
  };
  fs.mkdirSync(path.dirname(ws), { recursive: true });
  checked(run(process.execPath, [cli, "new", ws], root), "CLI new");
  fs.mkdirSync(path.join(ws, "src"));
  const items = [];
  for (let g = 0; g < goals; g++) {
    items.push({
      op: "create",
      ref: `g${g}`,
      name: `Goal${g}`,
      type: "goal",
      tags: ["requirement"],
      body: body(),
    });
    for (let p = 0; p < 2; p++)
      items.push({
        op: "create",
        ref: `g${g}p${p}`,
        name: `Decision${g}x${p}`,
        type: "prompt",
        tags: ["decision"],
        parent: `@g${g}`,
        body: body(),
      });
    for (let s = 0; s < 2; s++) {
      items.push({
        op: "create",
        ref: `g${g}s${s}`,
        name: `Sub${g}x${s}`,
        type: "goal",
        tags: ["todo"],
        parent: `@g${g}`,
        body: body(),
      });
      for (let o = 0; o < 2; o++) {
        const item = {
          op: "create",
          ref: `g${g}s${s}o${o}`,
          name: `Out${g}x${s}x${o}`,
          type: "output",
          tags: ["evidence"],
          parent: `@g${g}s${s}`,
          body: body(),
        };
        if (o === 0) {
          const file = path.join(ws, "src", `f${g}_${s}_${o}.ts`);
          fs.writeFileSync(file, `export const v${g}_${s}_${o} = ${g};\n`, { flag: "wx" });
          item.resource = pathToFileURL(file).href;
        }
        items.push(item);
      }
    }
  }
  const batchTimes = [];
  for (let start = 0; start < items.length; start += batch) {
    const result = tent(
      cli,
      ws,
      ["node", "write-many", "--input-json", "-", "--json"],
      JSON.stringify({ items: items.slice(start, start + batch) }),
    );
    checked(result, "CLI node write-many");
    batchTimes.push({ nodes: Math.min(batch, items.length - start), seconds: result.seconds });
  }
  const roles = [];
  for (let r = 0; r < 5; r++)
    roles.push(
      JSON.parse(
        checked(
          tent(cli, ws, ["role", "create", "--title", `Role${r}`, "--body", body(), "--json"]),
          "CLI role create",
        ),
      ).roleId,
    );
  const docs = collectDocs(path.join(ws, ".tent"));
  if (docs.length !== goals * 9) fail(`Expected ${goals * 9} Nodes, found ${docs.length}`);
  const head0 = git(ws, ["rev-parse", "HEAD"]);
  const branch = git(ws, ["symbolic-ref", "HEAD"]);
  const existing = Number(git(ws, ["rev-list", "--count", "HEAD"]));
  const consumed = cardCount - Math.ceil(cardCount / 5);
  const edits = totalCommits - existing - cardCount - consumed;
  if (edits < 0) fail(`Commit budget too small: need at least ${existing + cardCount + consumed}`);
  const goalsOnly = docs.filter((d) => d.type.startsWith("goal"));
  const nonGoals = docs.filter((d) => !d.type.startsWith("goal"));
  const blob = (s) => `data ${Buffer.byteLength(s)}\n${s}\n`;
  const message = (op, id) =>
    `Tent: ${op}\n\nTent-Operation: ${op}\nTent-Object: ${id}\nTent-Entry: cli`;
  let stream = "";
  let operations = 0;
  function commit(op, id, rel, raw) {
    stream += `commit ${branch}\ncommitter Tent <tent@local.invalid> ${1767225600 + operations * 600} +0000\n${blob(message(op, id))}`;
    if (operations === 0) stream += `from ${head0}\n`;
    stream += `M 100644 inline ${JSON.stringify(rel)}\n${blob(raw)}\n`;
    operations++;
  }
  for (let i = 0; i < edits; i++) {
    const pool = rand() < 0.03 ? goalsOnly : nonGoals;
    const d = pool[Math.floor(rand() * pool.length)];
    d.raw += `\nEdit ${i}: revised after review (${Math.floor(rand() * 1e6)}).\n`;
    commit("node.write", d.id, d.rel, d.raw);
  }
  const topGoals = docs.filter((d) => d.type === "goal" && d.rel.split("/").length === 2);
  for (let c = 0; c < cardCount; c++) {
    const id = `card-${c.toString(36).padStart(8, "0")}`;
    const goal = topGoals[c % topGoals.length];
    const role = roles[c % roles.length];
    const base = `---\ntype: card\nid: ${id}\nschemaVersion: 3\nsources:\n  - resource: ../${goal.rel}\n    version:\n      commit: ${head0}\n      path: ${goal.rel}\ntitle: Task ${c}\ntarget: ${role}\n`;
    const prompt = `---\nImplement task ${c} against the referenced goal and attach evidence.\n`;
    commit("card.create", id, `cards/${id}.md`, base + "state: pending\n" + prompt);
    if (c % 5 !== 0)
      commit(
        "card.take",
        id,
        `cards/${id}.md`,
        base + `state: consumed\nreceivedBy: ${role}\n` + prompt,
      );
  }
  if (operations) {
    git(ws, ["fast-import", "--quiet"], stream);
    // Populate imported tracked files without reset/clean/deletion operations.
    git(ws, ["read-tree", "HEAD"]);
    git(ws, ["checkout-index", "--all", "--force"]);
  }
  const count = Number(git(ws, ["rev-list", "--count", "HEAD"]));
  if (count !== totalCommits) fail(`Commit count mismatch: expected ${totalCommits}, got ${count}`);
  const result = {
    schemaVersion: 2, // 2: exact Node types with tags
    kind: "tent-cli-scale-fixture",
    workspace: ws,
    seed: 42,
    bodyBytes: 1024,
    goals,
    nodes: docs.length,
    commits: count,
    cards: cardCount,
    consumedCards: consumed,
    initialCommits: existing,
    syntheticEdits: edits,
    appendNodeId: topGoals.find((d) => d.rel === "Goal0/Goal0.md").id,
    head: git(ws, ["rev-parse", "HEAD"]),
    baselineHead: head0,
    batchTimes,
    cli: build,
  };
  fs.writeFileSync(path.join(ws, marker), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  return result;
}
function copyFixture(source, dest) {
  fs.mkdirSync(dest, { recursive: true });
  function copy(from, to) {
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      if (e.isSymbolicLink()) fail("Fixture contains symbolic links/junctions");
      if (
        path.basename(from) === ".git" &&
        (e.name === "tent-history-index.json" || /^tent-derived-.*\.json$/.test(e.name))
      )
        continue;
      const target = path.join(to, e.name);
      if (e.isDirectory()) {
        fs.mkdirSync(target);
        copy(path.join(from, e.name), target);
      } else if (e.isFile())
        fs.copyFileSync(path.join(from, e.name), target, fs.constants.COPYFILE_EXCL);
      else fail("Fixture contains a non-regular file");
    }
  }
  copy(source, dest);
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
    git: checked(run("git", ["--version"], process.cwd()), "git version"),
    cpuModel: cpus[0]?.model,
    cpuCount: cpus.length,
    cpuTimes: cpus.map((cpu) => cpu.times),
    totalMemory: os.totalmem(),
    freeMemory: os.freemem(),
    loadAverage: os.loadavg(),
    loadAverageNote:
      "Windows loadavg is always zero; CPU time deltas include every process on the machine",
  };
}
function cacheBytes(ws) {
  const dir = path.join(ws, ".tent", ".git");
  return Object.fromEntries(
    fs
      .readdirSync(dir)
      .filter((name) => name.startsWith("tent-") && fs.statSync(path.join(dir, name)).isFile())
      .map((name) => [name, fs.statSync(path.join(dir, name)).size]),
  );
}
function measure(root, ws, cli, opts, build) {
  const source = scratchPath(root, opts.fixture, "fixture");
  if (inside(source, ws) || inside(ws, source))
    fail("Fixture and measurement workspace must not contain each other");
  const fixture = JSON.parse(fs.readFileSync(path.join(source, marker), "utf8"));
  if (fixture.kind !== "tent-cli-scale-fixture" || fixture.schemaVersion !== 2)
    fail("Unsupported fixture marker");
  const materialRoot = scratchPath(root, fixture.workspace, "fixture-material-root");
  if (!fs.statSync(materialRoot).isDirectory()) fail("Original fixture materials must still exist");
  if (
    git(source, ["rev-parse", "HEAD"]) !== fixture.head ||
    Number(git(source, ["rev-list", "--count", "HEAD"])) !== fixture.commits
  )
    fail("Fixture retained history changed since generation");
  const repeats = integer(opts.repeats ?? "2", "repeats");
  const output = opts.output ? scratchPath(root, opts.output, "output", true) : null;
  if (output && (output === ws || inside(source, output)))
    fail("Output must not replace the workspace or write into the source fixture");
  copyFixture(source, ws);
  const samples = [];
  const before = machine();
  function sample(metric, args) {
    const observation = { freeMemory: os.freemem(), loadAverage: os.loadavg() };
    const result = tent(cli, ws, [...args, "--json"]);
    samples.push({
      metric,
      args,
      seconds: result.seconds,
      code: result.code,
      signal: result.signal,
      stdoutBytes: Buffer.byteLength(result.stdout),
      stdoutSha256: createHash("sha256").update(result.stdout).digest("hex"),
      stderr: result.stderr,
      observation,
    });
    checked(result, metric);
  }
  let measurementError = null;
  try {
    sample("briefCold", ["workspace", "brief"]);
    sample("cardListPrime", ["card", "list"]);
    for (let i = 0; i < repeats; i++) {
      sample("append", [
        "node",
        "append",
        fixture.appendNodeId,
        "--body",
        `Scale probe iteration ${i}: requirement revised after review.`,
      ]);
      sample("briefAfterWrite", ["workspace", "brief"]);
      sample("briefHot", ["workspace", "brief"]);
      sample("briefHot", ["workspace", "brief"]);
      sample("cardList", ["card", "list"]);
      sample("cardList", ["card", "list"]);
    }
  } catch (error) {
    measurementError = error.message;
  }
  const exact10x = fixture.nodes === 540 && fixture.commits === 4380 && fixture.cards === 100;
  const limits = { briefAfterWrite: 13.5, briefHot: 7.9, cardList: 2.2 };
  const finalCommits = Number(git(ws, ["rev-list", "--count", "HEAD"]));
  if (!measurementError && finalCommits !== fixture.commits + repeats)
    measurementError = "Measurement append sequence produced unexpected commit count";
  const cliHashAfter = createHash("sha256").update(fs.readFileSync(cli)).digest("hex");
  if (cliHashAfter !== build.sha256)
    measurementError = "CLI artifact changed during measurement; samples are not comparable";
  const result = {
    schemaVersion: 1,
    kind: "tent-cli-scale-measurement",
    label: opts.label ?? null,
    workspace: ws,
    sourceFixture: source,
    fixture,
    cli: build,
    machineBefore: before,
    machineAfter: machine(),
    repeats,
    finalCommits,
    error: measurementError,
    cliHashAfter,
    samples,
    cacheBytes: cacheBytes(ws),
    gateObservations:
      exact10x && !measurementError
        ? Object.fromEntries(
            Object.entries(limits).map(([metric, limitSeconds]) => {
              const seconds = samples
                .filter((sample) => sample.metric === metric)
                .map((sample) => sample.seconds);
              return [
                metric,
                {
                  limitSeconds,
                  seconds,
                  allWithinLimit: seconds.every((seconds) => seconds <= limitSeconds),
                },
              ];
            }),
          )
        : null,
    interpretation:
      "Observed subprocess timings only. Judge machine noise with the old CLI measured back-to-back; independent acceptance is external. No 10x gate conclusion for custom/1x fixtures.",
  };
  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  }
  return result;
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--help" || command === "help") {
    process.stdout.write(help);
  } else {
    if (!["generate", "measure"].includes(command))
      fail("Choose generate or measure; use --help for examples");
    const opts = options(args);
    const allowed =
      command === "generate"
        ? ["scale", "goals", "commits", "cards", "batch"]
        : ["fixture", "label", "repeats", "output"];
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
