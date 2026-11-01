import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { testScratchRoot } from "./scratch.js";
import {
  formatToolTurnReview,
  modulesForIndexedTurn,
  TOOL_REVIEW_ACTION,
  type TurnReviewModule,
} from "../src/core/return/tool-turn-review.js";
import type { StopMaterialIndex } from "../src/core/return/stop-material-index.js";
import { toolReviewOutput } from "../src/cli/hook-adapter.js";

const owner = (name: string, resource: string, rules = true): TurnReviewModule => ({
  nodeId: `node-${name}`,
  path: `.tent/${name}/${name}.md`,
  names: [name],
  files: [resource],
  body: "汉".repeat(1600),
  rules: rules
    ? [
        {
          nodeId: `node-${name}rule`,
          path: `.tent/${name}/Rule/Rule.md`,
          names: [name, "Rule"],
          body: "汉".repeat(1600),
        },
      ]
    : [],
});
const hints = (message: string) => [
  ...message.matchAll(/^(\d+) more Nodes: tent node search --resource (.+)$/gm),
];
const aggregate = (message: string) =>
  /^([0-9]+) more Nodes cover ([0-9]+) other changed files: run tent node search --resource on each\.$/m.exec(
    message,
  );

test("multi-file omission points to the omitted owner's resource instead of the delivered owner's file", () => {
  const modules = [owner("alpha", "alpha/a.ts"), owner("beta", "beta/b.ts", false)];
  const output = toolReviewOutput(modules)!;
  const message = JSON.parse(output.stdout).hookSpecificOutput.additionalContext;
  assert.deepEqual(output.nodeIds, ["node-alpha", "node-alpharule"]);
  assert.deepEqual(
    hints(message).map((hint) => [Number(hint[1]), hint[2]]),
    [[1, "beta/b.ts"]],
  );
  assert.ok(Buffer.byteLength(output.stdout) <= 8192);
});

test("omitted unrelated owners and their rules are grouped by recoverable files with exact total counts", () => {
  const modules = [
    owner("alpha", "alpha/a.ts"),
    owner("beta", "beta/b.ts"),
    owner("gamma", "gamma/c.ts"),
  ];
  const index: StopMaterialIndex = {
    nodes: modules.map((module) => ({
      nodeId: module.nodeId,
      path: module.path,
      names: module.names,
      moduleCoverage: [{ kind: "directory", prefix: module.files[0].split("/")[0] + "/" }],
      materialFiles: [],
      moduleMaterials: [],
      ruleNodeIds: module.rules!.map((rule) => rule.nodeId),
    })),
  };
  for (const budget of [1800, 8192]) {
    const output = formatToolTurnReview(budget, modules)!;
    assert.ok(Buffer.byteLength(output.message) <= budget);
    const omitted = new Set(
      modules
        .flatMap((module) => [module.nodeId, ...module.rules!.map((rule) => rule.nodeId)])
        .filter((id) => !output.nodeIds.includes(id)),
    );
    const lines = hints(output.message);
    const remainder = aggregate(output.message);
    assert.equal(
      lines.reduce((total, hint) => total + Number(hint[1]), 0) + Number(remainder?.[1] ?? 0),
      omitted.size,
    );
    const recovered = new Set<string>();
    for (const hint of lines) {
      const selected = modulesForIndexedTurn(index, {
        files: [{ kind: "written", address: hint[2] }],
      });
      const relevant = new Set(
        selected.flatMap((module) => [
          module.nodeId,
          ...(index.nodes.find((node) => node.nodeId === module.nodeId)!.ruleNodeIds ?? []),
        ]),
      );
      const group = [...omitted].filter((id) => relevant.has(id));
      assert.equal(group.length, Number(hint[1]));
      for (const id of group) {
        assert.equal(recovered.has(id), false);
        recovered.add(id);
      }
    }
    assert.equal(omitted.size - recovered.size, Number(remainder?.[1] ?? 0));
    const omittedFiles = new Set(
      modules
        .filter((module) =>
          [module.nodeId, ...module.rules!.map((rule) => rule.nodeId)].some((id) =>
            omitted.has(id),
          ),
        )
        .map((module) => module.files[0]),
    );
    assert.equal(omittedFiles.size - lines.length, Number(remainder?.[2] ?? 0));
  }
  const envelope = toolReviewOutput(modules)!;
  assert.ok(Buffer.byteLength(envelope.stdout) <= 8192);
  const message = JSON.parse(envelope.stdout).hookSpecificOutput.additionalContext;
  for (const hint of hints(message)) assert.ok(["beta/b.ts", "gamma/c.ts"].includes(hint[2]));
  assert.equal(
    hints(message).reduce((total, hint) => total + Number(hint[1]), 0) +
      Number(aggregate(message)?.[1] ?? 0),
    4,
  );
  assert.deepEqual(envelope.ownerNodeIds, ["node-alpha"]);
  assert.deepEqual(envelope.ruleNodeIds, ["node-alpharule"]);
});

test("wide legal changed-file sets preserve fixed text, body priority, recovery counts and rendered-only claim IDs within the JSON limit", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "hook-wide-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resources = Array.from(
    { length: 256 },
    (_, i) =>
      `p${String(i).padStart(3, "0")}/${"directory".repeat(12)}/${"filename".repeat(12)}-${i}.ts`,
  );
  await Promise.all(
    resources.map(async (resource) => {
      const filename = path.join(root, resource);
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, "legal long path\n");
    }),
  );
  for (const total of [56, 100, 256]) {
    const files = resources.slice(0, total);
    const modules = files.map((resource, i) => owner(`n${String(i).padStart(3, "0")}`, resource));
    for (const metadataOnly of [false, true]) {
      const input = metadataOnly
        ? [{ ...owner("batch", files[0], false), files }, ...modules]
        : modules;
      const output = toolReviewOutput(input)!;
      assert.ok(output, `${total} files must produce a notification`);
      assert.ok(Buffer.byteLength(output.stdout) <= 8192);
      const message = JSON.parse(output.stdout).hookSpecificOutput.additionalContext;
      assert.ok(message.startsWith("Tent: these Nodes cover the file you just changed.\n\n"));
      assert.ok(message.endsWith(TOOL_REVIEW_ACTION));
      const totalNodes = input.reduce(
        (count, module) => count + 1 + (module.rules?.length ?? 0),
        0,
      );
      const lines = hints(message);
      const remaining = aggregate(message);
      assert.ok(remaining, `${total} long paths require an aggregate recovery line`);
      assert.equal(
        lines.reduce((count, hint) => count + Number(hint[1]), 0) + Number(remaining[1]),
        totalNodes - output.nodeIds.length,
      );
      assert.deepEqual(
        lines.map((hint) => hint[2]),
        files.slice(metadataOnly ? 0 : 1, (metadataOnly ? 0 : 1) + lines.length),
      );
      assert.equal(Number(remaining[2]), total - lines.length - (metadataOnly ? 0 : 1));
      assert.deepEqual(
        [...message.matchAll(/\((node-[a-z0-9]+), /g)].map((match) => match[1]),
        output.nodeIds,
      );
      if (metadataOnly) {
        assert.deepEqual(output.nodeIds, []);
        assert.deepEqual(output.ownerNodeIds, []);
        assert.deepEqual(output.ruleNodeIds, []);
        assert.ok(lines.length > 0 && lines.length < total);
      } else {
        assert.deepEqual(output.nodeIds, ["node-n000", "node-n000rule"]);
        assert.deepEqual(output.ownerNodeIds, ["node-n000"]);
        assert.deepEqual(output.ruleNodeIds, ["node-n000rule"]);
        assert.ok(
          message.includes("汉".repeat(1600)),
          "recovery line volume must not displace the first body's 1600-codepoint prefix",
        );
      }
      const turn = formatToolTurnReview(7500, input, "turn")!;
      assert.ok(
        turn.message.startsWith("Tent: these Nodes cover files changed during this turn.\n\n"),
      );
      assert.ok(turn.message.endsWith(TOOL_REVIEW_ACTION));
      assert.ok(
        Buffer.byteLength(JSON.stringify({ decision: "block", reason: turn.message }) + "\n") <=
          8192,
      );
      t.diagnostic(
        JSON.stringify({
          total,
          metadataOnly,
          bytes: Buffer.byteLength(output.stdout),
          delivered: output.nodeIds,
          detailedFiles: lines.length,
          remainingNodes: Number(remaining[1]),
          remainingFiles: Number(remaining[2]),
        }),
      );
    }
  }
});

test("omission commands preserve real special-name paths through the current platform shell", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "hook-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const capture = path.join(root, "capture.cjs");
  await fs.writeFile(capture, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  const windows = process.platform === "win32";
  const resources = [
    "src/ordinary.ts",
    "src/$a.ts",
    "src/back`tick.ts",
    "src/it's two.ts",
    "src/a&b;(q) [x]!.ts",
    "src/‘curly’.ts",
    "src/‚low‛.ts",
    ...(windows ? [] : ['src/double"quote.ts']),
  ];
  for (const resource of resources) {
    const filename = path.join(root, resource);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, "real legal filename\n");
    assert.equal(await fs.readFile(filename, "utf8"), "real legal filename\n");
    const module = { ...owner("omitted", resource), names: ["x".repeat(9000)] };
    const output = formatToolTurnReview(8192, [module])!;
    assert.deepEqual(output.nodeIds, []);
    const line = hints(output.message)[0];
    assert.equal(Number(line[1]), 2);
    const command = line[0].replace(/^\d+ more Nodes: /, "");
    const define = windows
      ? "$a='expanded'; function tent { & $env:TENT_RECOVERY_NODE $env:TENT_CAPTURE_SCRIPT @args }; "
      : 'a=expanded; export a; tent() { "$TENT_RECOVERY_NODE" "$TENT_CAPTURE_SCRIPT" "$@"; }; ';
    const stdout = execFileSync(
      windows ? "pwsh" : "/bin/sh",
      windows
        ? ["-NoProfile", "-NonInteractive", "-Command", define + command]
        : ["-c", define + command],
      {
        encoding: "utf8",
        windowsHide: true,
        cwd: root,
        env: { ...process.env, TENT_RECOVERY_NODE: process.execPath, TENT_CAPTURE_SCRIPT: capture },
      },
    );
    const capturedArguments = JSON.parse(stdout);
    assert.deepEqual(capturedArguments, ["node", "search", "--resource", resource], resource);
    t.diagnostic(
      JSON.stringify({ shell: windows ? "pwsh" : "/bin/sh", resource, command, capturedArguments }),
    );
    if (resource === "src/ordinary.ts") assert.ok(command.endsWith("--resource src/ordinary.ts"));
  }
});
