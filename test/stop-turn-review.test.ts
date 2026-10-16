import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadNodeCatalog } from "../src/core/graph/node-catalog.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import {
  structureMaterialCoverage,
  materialCoverageContains,
} from "../src/core/base/material-coverage.js";
import {
  formatStopTurnReview,
  TURN_REVIEW_ACTION,
  TURN_REVIEW_RULE,
} from "../src/core/return/stop-turn-review.js";
import type { SessionObservationEvent } from "../src/core/return/session-observations.js";
import type { StopQuestion } from "../src/core/return/stop-advice.js";
import { runHookCommand } from "../src/cli/hook.js";
import { readClaudeTurnActivity } from "../src/cli/claude-turn-activity.js";
import { loadStopMaterialIndex } from "../src/fs/stop-material-index.js";
import { modulesForIndexedTurn } from "../src/core/return/stop-turn-review.js";
import { buildStopMaterialIndex } from "../src/core/return/stop-material-index.js";
import { createHash } from "node:crypto";
import { isUsableNode } from "../src/core/store/tree.js";
import { questionsForIndexedTurn, stopAdvice } from "../src/core/return/stop-advice.js";
import { codexHookAdapter } from "../src/cli/codex-turn-activity.js";
import { claudeHookAdapter } from "../src/cli/claude-turn-activity.js";
import { stopReviewOutput } from "../src/cli/hook-adapter.js";

const event = (files: string[] = []): SessionObservationEvent => ({
  turnId: "turn",
  files: files.map((address) => ({
    kind: "written",
    address,
  })),
  signals: [],
  uncertain: false,
});

async function fixture(t: TestContext) {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "stop-review-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  await scaffoldInWorkspace(new NodeFs(root), { name: "review" });
  const adapter = new NodeFs(path.join(root, ".tent"));
  const node = async (nodePath: string, id: string, resource: string, track = true, extra = "") => {
    const name = nodePath.split("/").pop()!;
    await fs.mkdir(path.join(root, ".tent", nodePath), { recursive: true });
    await adapter.writeFile(
      `${nodePath}/${name}.md`,
      `---\nid: ${id}\ntype: output\nsources:\n  - resource: ${resource}\n${track ? "    track: structure\n" : ""}${extra}---\nModule rule\n`,
    );
  };
  await fs.mkdir(path.join(root, "src", "core"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "core", "card-one.ts"), "one");
  await node("Core", "node-core", "../../src/core/");
  await node("Core/Card", "node-card", "../../../src/core/card-*");
  await node("AlsoCard", "node-equal", "../../src/core/card-*");
  await node("Evidence", "node-evidence", "../../src/core/", false, "tags: [module]\n");
  return { root, adapter, node };
}

test("shared structure coverage validates prefixes and directory/path boundaries", () => {
  const root = path.resolve(".scratch", "coverage");
  const owner = "Module/Module.md";
  const directory = structureMaterialCoverage("../../src/core/", owner, root)!;
  assert.deepEqual(directory, { kind: "directory", prefix: "src/core/" });
  assert.equal(materialCoverageContains(directory, "src/core/card.ts"), true);
  assert.equal(materialCoverageContains(directory, "src/corex/card.ts"), false);
  assert.equal(materialCoverageContains(directory, "src/core/../outside.ts"), false);
  const prefix = structureMaterialCoverage("../../src/core/card-*", owner, root)!;
  assert.equal(materialCoverageContains(prefix, "src/core/card-x.ts"), true);
  assert.equal(materialCoverageContains(prefix, "src/core/card-x/nested.ts"), true);
  assert.equal(materialCoverageContains(prefix, "src/core/other.ts"), false);
  for (const resource of [
    "../../src/*/card-*",
    "../../src/core/card-**",
    "../../src/core/*/",
    "../../src/core/card-*#section",
    "src/core/card-*",
    "../../../outside/*",
    "../../src/core/card.ts",
  ])
    assert.equal(structureMaterialCoverage(resource, owner, root), undefined, resource);
});

test("modules require explicit structure sources and retain all equally specific owners with ancestors", async (t) => {
  const { root, adapter, node } = await fixture(t);
  await node(
    "Deprecated",
    "node-deprecated",
    "../../src/core/card-*",
    true,
    "status: deprecated\n",
  );
  const catalog = await loadNodeCatalog(adapter);
  const modules = modulesForIndexedTurn(
    buildStopMaterialIndex(catalog, root),
    event(["src/core/card-one.ts", "src/core/other.ts"]),
  );
  assert.deepEqual(modules.map((module) => module.nodeId).sort(), [
    "node-card",
    "node-core",
    "node-equal",
  ]);
  assert.deepEqual(modules.find((module) => module.nodeId === "node-core")!.files, [
    "src/core/other.ts",
  ]);
  assert.deepEqual(modules.find((module) => module.nodeId === "node-card")!.names, [
    "Core",
    "Card",
  ]);
  assert.equal(
    modules.find((module) => module.nodeId === "node-card")!.path,
    ".tent/Core/Card/Card.md",
  );
  assert.deepEqual(
    modulesForIndexedTurn(
      buildStopMaterialIndex(catalog, root, [
        ".tent/Core/Card/Card.md",
        ".tent/AlsoCard/AlsoCard.md",
      ]),
      event(["src/core/card-one.ts"]),
    ).map((module) => module.nodeId),
    ["node-core"],
  );
  assert.deepEqual(modulesForIndexedTurn(buildStopMaterialIndex(catalog, root), event()), []);
  assert.deepEqual(
    modulesForIndexedTurn(buildStopMaterialIndex(catalog, root), event(["uncovered.ts"])),
    [],
  );
  assert.deepEqual(
    modulesForIndexedTurn(buildStopMaterialIndex(catalog, root), {
      ...event(["src/core/card-one.ts"]),
      cancelled: true,
    }),
    [],
  );
  assert.deepEqual(
    modulesForIndexedTurn(buildStopMaterialIndex(catalog, root), {
      ...event(["src/core/card-one.ts"]),
      files: event(["src/core/card-one.ts"]).files.map((file) => ({ ...file, kind: "read" })),
    }),
    [],
  );
});

const questions: StopQuestion[] = [
  {
    kind: "possible-intent",
    question: "new requirement?",
    answers: ["Create goal", "Discussion only"],
  },
  {
    kind: "possible-intent",
    question: "new decision?",
    answers: ["Update", "Create", "Discussion"],
  },
];
test("Core budgets UTF-8 text independently of any host envelope", () => {
  const modules = [
    { nodeId: "node-one", path: "模块/one.md", names: ["模块"], files: ["src/a.ts"] },
  ];
  const full = formatStopTurnReview(4096, modules, questions)!;
  const bytes = Buffer.byteLength(full);
  assert.ok(bytes > full.length);
  assert.equal(formatStopTurnReview(bytes, modules, questions), full);
  const bounded = formatStopTurnReview(bytes - 1, modules, questions)!;
  assert.ok(Buffer.byteLength(bounded) <= bytes - 1);
  assert.ok(bounded.includes(TURN_REVIEW_RULE));
  assert.ok(bounded.includes(TURN_REVIEW_ACTION));
  assert.equal(formatStopTurnReview(1, modules, questions), undefined);
});

test("both native envelopes merge all questions and keep fixed text within 2 KiB", () => {
  for (const host of ["codex", "claude-code"] as const) {
    const adapter = host === "codex" ? codexHookAdapter : claudeHookAdapter;
    const modules = Array.from({ length: 7 }, (_, index) => ({
      nodeId: `node-${index}`,
      path: `Core/Module${index}`,
      names: ["Core", `Module${index}`],
      files: Array.from({ length: 10 }, (_, file) => `src/core/${index}-${file}.ts`),
    }));
    let message = "";
    const output = stopReviewOutput(adapter, (budget) => {
      message = formatStopTurnReview(budget, modules, questions)!;
      return message;
    })!;
    assert.ok(message.includes(TURN_REVIEW_RULE));
    assert.ok(message.includes(TURN_REVIEW_ACTION));
    assert.equal((message.match(/^[1-3]\. /gm) ?? []).length, 2);
    assert.match(message, /\+\d+ more modules/);
    assert.ok((message.match(/^- /gm) ?? []).length <= 5);
    assert.ok(Buffer.byteLength(output) <= 2048);
    let huge = "";
    const hugeOutput = stopReviewOutput(adapter, (budget) => {
      huge = formatStopTurnReview(
        budget,
        modules.map((module) => ({
          ...module,
          path: '模块\\"'.repeat(2000),
          names: ["名".repeat(2000)],
        })),
        questions.map((question) => ({
          ...question,
          question: '问题\\"\n'.repeat(2000),
          answers: question.answers.map(() => '回答\\"\t'.repeat(2000)),
        })),
      )!;
      return huge;
    })!;
    assert.ok(huge.includes(TURN_REVIEW_RULE));
    assert.ok(huge.includes(TURN_REVIEW_ACTION));
    assert.equal((huge.match(/^[1-3]\. /gm) ?? []).length, 2);
    assert.ok(Buffer.byteLength(hugeOutput) <= 2048);
    assert.equal(formatStopTurnReview(2048, [], questions), undefined);
    const envelope = adapter.stopEnvelope("review");
    assert.deepEqual(
      envelope,
      host === "codex"
        ? { decision: "block", reason: "review" }
        : { hookSpecificOutput: { hookEventName: "Stop", additionalContext: "review" } },
    );
  }
});

for (const host of ["codex", "claude-code"] as const) {
  test(`${host} reclaims filename escaping overhead before dropping the only Node`, () => {
    const adapter = host === "codex" ? codexHookAdapter : claudeHookAdapter;
    const boundaryLengths = host === "codex" ? [158, 158, 158, 159] : [156, 154, 154, 153];
    const cases = [
      {
        lengths: Array(4).fill(host === "codex" ? 137 : 132) as number[],
        file: '"'.repeat(host === "codex" ? 193 : 200),
        bytes: host === "codex" ? 1856 : 1849,
      },
      ...['"', "a", " "].map((file) => ({ lengths: boundaryLengths, file, bytes: 2048 })),
    ];
    for (const { lengths, file, bytes } of cases) {
      const names = lengths.map((length, index) => `${index}${"x".repeat(length - 1)}`);
      const node = {
        nodeId: "node-one",
        path: `.tent/${names.join("/")}/${names.at(-1)}.md`,
        names,
        moduleCoverage: [{ kind: "directory" as const, prefix: "" }],
      };
      const withoutFilename = formatStopTurnReview(4096, [{ ...node, files: [] }], [])!;
      const expected = JSON.stringify(adapter.stopEnvelope(withoutFilename)) + "\n";
      assert.equal(Buffer.byteLength(expected), bytes);
      const output = stopReviewOutput(adapter, (budget) =>
        stopAdvice({ nodes: [node] }, event([file]), budget),
      )!;
      assert.ok(Buffer.byteLength(output) <= 2048);
      const envelope = JSON.parse(output);
      const message =
        host === "codex" ? envelope.reason : envelope.hookSpecificOutput.additionalContext;
      assert.ok(message.includes(`(${node.nodeId}, ${node.path})`));
      assert.ok(message.includes(TURN_REVIEW_RULE));
      assert.ok(message.includes(TURN_REVIEW_ACTION));
      assert.equal(output, expected);
    }
  });
}

function claudeTranscript(root: string, promptId: string, tool = "Write", error = false) {
  const file = path.join(root, "src/core/card-one.ts");
  return (
    [
      {
        type: "user",
        promptId,
        isSidechain: false,
        cwd: root,
        message: { content: "please edit file" },
      },
      {
        type: "assistant",
        cwd: root,
        message: {
          content: [{ type: "tool_use", id: "call", name: tool, input: { file_path: file } }],
        },
      },
      {
        type: "user",
        promptId,
        cwd: root,
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "call",
              ...(error ? { is_error: true } : {}),
              content: "opaque payload",
            },
          ],
        },
        toolUseResult:
          tool === "Read"
            ? { type: "text", file: { filePath: file } }
            : tool === "Edit"
              ? { filePath: file, structuredPatch: [] }
              : { type: "create", filePath: file },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n"
  );
}

test("Claude native identity bounds successful reads/writes and ignores failures, sidechains and later prompts", async (t) => {
  const { root } = await fixture(t);
  const log = path.join(root, "claude.jsonl");
  await fs.writeFile(
    log,
    claudeTranscript(root, "write") +
      claudeTranscript(root, "overwrite").replace('"type":"create"', '"type":"update"') +
      claudeTranscript(root, "read", "Read") +
      claudeTranscript(root, "edit", "Edit") +
      claudeTranscript(root, "failed", "Write", true),
  );
  for (const [prompt, kind] of [
    ["write", "written"],
    ["overwrite", "written"],
    ["read", "read"],
    ["edit", "written"],
  ]) {
    const activity = await readClaudeTurnActivity(log, root, prompt);
    assert.equal(activity.uncertain, false);
    assert.deepEqual(
      activity.observations.map(({ kind, address }) => ({ kind, address })),
      [{ kind, address: "src/core/card-one.ts" }],
    );
  }
  assert.deepEqual((await readClaudeTurnActivity(log, root, "failed")).observations, []);
  assert.deepEqual((await readClaudeTurnActivity(log, root, undefined)).observations, []);
  await fs.writeFile(
    log,
    claudeTranscript(root, "side").replaceAll('"isSidechain":false', '"isSidechain":true'),
  );
  assert.deepEqual((await readClaudeTurnActivity(log, root, "side")).observations, []);
});

test("native Stop qualifies writes once, stays silent for active later tools, uncovered and empty turns", async (t) => {
  const { root, adapter } = await fixture(t);
  const log = path.join(root, "turn.jsonl");
  const hook = async (
    host: "codex" | "claude-code",
    id: string,
    file: string | undefined,
    active = false,
    cancelled = false,
  ) => {
    await fs.writeFile(
      log,
      host === "claude-code"
        ? claudeTranscript(root, id)
        : [
            { type: "event_msg", payload: { type: "task_started", turn_id: id } },
            ...(file
              ? [
                  {
                    type: "event_msg",
                    payload: {
                      type: "item_completed",
                      turn_id: id,
                      item: {
                        type: "FileChange",
                        status: "completed",
                        changes: { [file]: { type: "update" } },
                      },
                    },
                  },
                ]
              : []),
            ...(cancelled
              ? [{ type: "event_msg", payload: { type: "turn_aborted", turn_id: id } }]
              : []),
          ]
            .map((row) => JSON.stringify(row))
            .join("\n") + "\n",
    );
    return runHookCommand("stop", ["--host", host], {
      packageRoot: root,
      stdin: JSON.stringify({
        hook_event_name: "Stop",
        cwd: root,
        session_id: host,
        transcript_path: log,
        ...(host === "codex" ? { turn_id: id } : { prompt_id: id }),
        stop_hook_active: active,
      }),
    });
  };
  assert.equal((await hook("codex", "none", undefined)).stdout, "{}\n");
  assert.equal((await hook("codex", "outside", "uncovered.ts")).stdout, "{}\n");
  assert.equal(
    (await hook("codex", "cancelled", "src/core/card-one.ts", false, true)).stdout,
    "{}\n",
  );
  for (const host of ["codex", "claude-code"] as const) {
    const first = await hook(host, "qualifies", "src/core/card-one.ts");
    const result = JSON.parse(first.stdout);
    assert.ok(
      host === "codex"
        ? result.decision === "block" && result.reason
        : result.hookSpecificOutput?.additionalContext,
    );
    assert.ok(Buffer.byteLength(first.stdout) <= 2048);
    assert.equal((await hook(host, "qualifies", "src/core/card-one.ts")).stdout, "{}\n");
    assert.equal((await hook(host, "later-tools", "src/core/card-one.ts", true)).stdout, "{}\n");
    assert.equal(await adapter.exists("temp/observations"), false);
    const broken = await runHookCommand("stop", ["--host", host], {
      packageRoot: root,
      stdin: JSON.stringify({ hook_event_name: "Stop", cwd: root, stop_hook_active: true }),
    });
    assert.equal(broken.stdout, "{}\n");
  }
});

test("Stop excludes unknown lifecycle from modules and ordinary materials across cold, hot and old caches", async (t) => {
  const { root, adapter, node } = await fixture(t);
  const systemRoot = path.join(root, ".tent");
  await node("UnknownModule", "node-unknownmodule", "../../unknown/", true, "status: mystery\n");
  await node(
    "UnknownEvidence",
    "node-unknownevidence",
    "../../only-unknown.txt",
    false,
    "status: mystery\n",
  );
  await node("Draft", "node-draft", "../../draft/", true, "status: draft\n");
  await node("Stable", "node-stable", "../../live/", true, "status: stable\n");
  await node("Deprecated", "node-deprecated", "../../old/", true, "status: deprecated\n");
  const unknownModulePath = "UnknownModule/UnknownModule.md";
  const unknownEvidencePath = "UnknownEvidence/UnknownEvidence.md";
  const moduleRaw = await adapter.readFile(unknownModulePath);
  const evidenceRaw = await adapter.readFile(unknownEvidencePath);
  const catalog = await loadNodeCatalog(adapter);
  for (const id of ["node-unknownmodule", "node-unknownevidence"]) {
    const current = catalog.tree.byId.get(id)!;
    assert.equal(current.invalid, false);
    assert.equal(current.status, null);
    assert.equal(isUsableNode(current), false);
    assert.match(current.statusDiagnostic!, /preserved without assuming currentness/);
  }
  const expected = buildStopMaterialIndex(catalog, root);
  for (const id of ["node-draft", "node-stable", "node-core"])
    assert.ok(expected.nodes.some((node) => node.nodeId === id));
  for (const id of ["node-unknownmodule", "node-unknownevidence", "node-deprecated"])
    assert.ok(!expected.nodes.some((node) => node.nodeId === id));
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), expected);
  await fs.mkdir(path.join(systemRoot, ".git"));
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), expected);
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), expected);
  const cacheFile = path.join(systemRoot, ".git/tent-material-cache/stop-material-index.json");
  const legacy = JSON.parse(await fs.readFile(cacheFile, "utf8"));
  legacy.schema = 2;
  legacy.index.nodes.push({
    nodeId: "node-unknownmodule",
    path: `.tent/${unknownModulePath}`,
    names: ["UnknownModule"],
    type: "output",
    materials: [{ coverage: { kind: "directory", prefix: "unknown/" } }],
    moduleCoverage: [{ kind: "directory", prefix: "unknown/" }],
  });
  legacy.indexDigest = createHash("sha256").update(JSON.stringify(legacy.index)).digest("hex");
  await fs.writeFile(cacheFile, JSON.stringify(legacy));
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), expected);
  assert.equal(JSON.parse(await fs.readFile(cacheFile, "utf8")).schema, 3);
  assert.deepEqual(modulesForIndexedTurn(expected, event(["unknown/a.ts"])), []);
  assert.deepEqual(questionsForIndexedTurn(expected, event(["only-unknown.txt"])), []);
  const transcript = path.join(root, "unknown-lifecycle.jsonl");
  await fs.writeFile(
    transcript,
    [
      { type: "event_msg", payload: { type: "task_started", turn_id: "unknown-status" } },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "unknown-status",
          item: {
            type: "FileChange",
            status: "completed",
            changes: { "unknown/a.ts": { type: "update" } },
          },
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  assert.equal(
    (
      await runHookCommand("stop", ["--host", "codex"], {
        packageRoot: root,
        stdin: JSON.stringify({
          hook_event_name: "Stop",
          cwd: root,
          session_id: "lifecycle",
          turn_id: "unknown-status",
          transcript_path: transcript,
        }),
      })
    ).stdout,
    "{}\n",
  );
  await fs.writeFile(
    path.join(systemRoot, unknownModulePath),
    moduleRaw.replace("status: mystery", "status: stable"),
  );
  await fs.writeFile(
    path.join(systemRoot, unknownEvidencePath),
    evidenceRaw.replace("status: mystery", "status: stable"),
  );
  const repaired = await loadStopMaterialIndex(systemRoot, root);
  assert.deepEqual(
    modulesForIndexedTurn(repaired, event(["unknown/a.ts"])).map((module) => module.nodeId),
    ["node-unknownmodule"],
  );
  assert.deepEqual(questionsForIndexedTurn(repaired, event(["only-unknown.txt"])), []);
  await fs.writeFile(path.join(systemRoot, unknownModulePath), moduleRaw);
  await fs.writeFile(path.join(systemRoot, unknownEvidencePath), evidenceRaw);
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), expected);
  assert.equal(await adapter.readFile(unknownModulePath), moduleRaw);
  assert.equal(await adapter.readFile(unknownEvidencePath), evidenceRaw);
  assert.equal((await loadNodeCatalog(adapter)).tree.byId.get("node-unknownmodule")!.status, null);
});

test("material index header scan preserves chunk boundaries, malformed ancestry and body independence", async (t) => {
  const { root, adapter } = await fixture(t);
  const systemRoot = path.join(root, ".tent");
  await fs.mkdir(path.join(systemRoot, ".git"));
  for (const [name, raw] of [
    [
      "Long",
      `\uFEFF---\r\nid: node-long\r\ntype: output\r\ndescription: "${"a".repeat(4085)}😀"\r\nsources:\r\n  - resource: ../../src/core/\r\n    track: structure\r\n--- \t\r\n${"body\n".repeat(100_000)}`,
    ],
    ["Broken", `---\nid: node-broken\ntype: output\ndescription: ${"a".repeat(5000)}\n`],
    [
      "Broken/Child",
      "---\nid: node-child\ntype: output\nsources:\n  - resource: ../../../src/core/\n    track: structure\n---\nChild",
    ],
  ]) {
    await fs.mkdir(path.join(systemRoot, name), { recursive: true });
    const filename = `${name}/${name.split("/").pop()}.md`;
    await fs.writeFile(path.join(systemRoot, filename), raw);
  }
  const fullRead = new Proxy(adapter, {
    get(target, key) {
      if (key === "readFrontmatter") return undefined;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const expected = buildStopMaterialIndex(await loadNodeCatalog(fullRead), root);
  assert.ok(expected.nodes.some((node) => node.nodeId === "node-long"));
  assert.ok(!expected.nodes.some((node) => node.nodeId === "node-child"));
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), expected);
  const cacheFile = path.join(
    systemRoot,
    ".git",
    "tent-material-cache",
    "stop-material-index.json",
  );
  const cached = await fs.readFile(cacheFile, "utf8");
  await fs.appendFile(path.join(systemRoot, "Long/Long.md"), "body-only addition");
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), expected);
  assert.equal(await fs.readFile(cacheFile, "utf8"), cached);
});

test("material index cache validates live bytes and topology; missing, corrupt and unwritable caches preserve results", async (t) => {
  const { root, adapter, node } = await fixture(t);
  const systemRoot = path.join(root, ".tent");
  await fs.mkdir(path.join(systemRoot, ".git"));
  const cacheDirectory = path.join(systemRoot, ".git", "tent-material-cache");
  const cacheFile = path.join(cacheDirectory, "stop-material-index.json");
  const original = await loadStopMaterialIndex(systemRoot, root);
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), original);
  const filename = path.join(systemRoot, "Core", "Card", "Card.md");
  const originalRaw = await fs.readFile(filename, "utf8");
  const stat = await fs.stat(filename);
  await fs.writeFile(filename, originalRaw.replace("card-*", "cord-*"));
  await fs.utimes(filename, stat.atime, stat.mtime);
  const changed = await loadStopMaterialIndex(systemRoot, root);
  assert.ok(
    !modulesForIndexedTurn(changed, event(["src/core/card-one.ts"])).some(
      (module) => module.nodeId === "node-card",
    ),
  );
  await fs.writeFile(filename, originalRaw);
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), original);
  await node("Added", "node-added", "../../src/new/", true);
  assert.ok(
    (await loadStopMaterialIndex(systemRoot, root)).nodes.some(
      (node) => node.nodeId === "node-added",
    ),
  );
  await fs.rm(path.join(systemRoot, "Added"), { recursive: true });
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), original);
  await adapter.mkdir("returns");
  await loadStopMaterialIndex(systemRoot, root);
  await adapter.writeFile("returns/return-old.json", "{}");
  await assert.rejects(loadStopMaterialIndex(systemRoot, root), /Retired Tent storage/);
  await fs.rm(path.join(systemRoot, "returns"), { recursive: true });
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), original);
  await fs.rm(cacheFile);
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), original);
  const cached = JSON.parse(await fs.readFile(cacheFile, "utf8"));
  cached.index.nodes = [];
  await fs.writeFile(cacheFile, JSON.stringify(cached));
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), original);
  await fs.writeFile(cacheFile, "broken JSON");
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), original);
  await fs.rm(cacheDirectory, { recursive: true });
  await fs.writeFile(cacheDirectory, "not a directory");
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), original);
  assert.equal(await fs.readFile(filename, "utf8"), originalRaw);
  assert.deepEqual((await fs.readdir(path.join(systemRoot, ".git"))).sort(), [
    "tent-material-cache",
  ]);
  assert.equal(await adapter.exists("temp/stop-reviews"), false);
});
