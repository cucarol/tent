import { openTestFs, removeTestFixture } from "./node-fs.js";
import { historyHead } from "./scratch.js";
import { initializeFixtureHistory } from "./scratch.js";
import { testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { spawn } from "node:child_process";
import { runCardCommand, cardHelpText } from "../src/cli/card-commands.js";
import { runRoleCommand } from "../src/cli/role-commands.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/base/frontmatter.js";
import { scaffoldInWorkspace } from "./scaffold.js";

async function fileSnapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await fs.readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const stat = await fs.stat(file);
    files[path.relative(root, file)] =
      `${stat.mtimeMs}:${(await fs.readFile(file)).toString("base64")}`;
  }
  return files;
}

test("Card watch checks once without any file writes and distinguishes timeout from errors", async (t) => {
  const { root, globals } = await fixture(t);
  const role = value(await runRoleCommand("create", ["--title", "Watch"], globals));
  const systemRoot = path.join(root, ".tent");
  const before = await fileSnapshot(systemRoot);
  assert.deepEqual(
    await runCardCommand("watch", ["--role", role.roleId, "--timeout", "0"], globals),
    {
      exitCode: 2,
      stdout: "",
      stderr: "",
    },
  );
  assert.deepEqual(await fileSnapshot(systemRoot), before);
  for (const args of [
    [],
    ["--role", "role-missing"],
    ["--role", role.roleId, "--timeout", "-1"],
    ["--role", role.roleId, "--timeout", "NaN"],
    ["--role", role.roleId, "--timeout", ""],
  ]) {
    const result = await runCardCommand("watch", args, globals);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr);
  }
  assert.match(cardHelpText(), /2 = timeout \(no output\); 1 = error/);
});

test("Card watch returns only committed current pending input for the exact Role", async (t) => {
  const { root, globals } = await fixture(t);
  const role = value(await runRoleCommand("create", ["--title", "Watch"], globals));
  const other = value(await runRoleCommand("create", ["--title", "Other"], globals));
  const create = (title: string, target: string) =>
    runCardCommand(
      "create",
      ["--prompt", "Work", "--title", title, "--target", target],
      globals,
    ).then(value);
  await create("Other", other.roleId);
  const consumed = await create("Consumed", role.roleId);
  value(await runCardCommand("take", [consumed.cardId, "--role", role.roleId], globals));
  const cancelled = await create("Cancelled", role.roleId);
  value(await runCardCommand("deprecate", [cancelled.cardId], globals));
  const first = await create("First\nline", role.roleId);
  const second = await create("Second", role.roleId);
  const systemRoot = path.join(root, ".tent");
  const unpublished = (await fs.readFile(cardFile(root, first.cardId), "utf8")).replaceAll(
    first.cardId,
    "card-unpublished",
  );
  await fs.writeFile(path.join(systemRoot, "cards/card-unpublished.md"), unpublished);
  const before = await fileSnapshot(systemRoot);
  const args = ["--role", role.roleId, "--timeout", "0"];
  const items = value(await runCardCommand("watch", args, globals));
  assert.deepEqual(
    items.map((item: { cardId: string }) => item.cardId).sort(),
    [first.cardId, second.cardId].sort(),
  );
  const text = await runCardCommand("watch", args, { workspace: root });
  assert.equal(text.exitCode, 0);
  assert.equal(text.stdout.trim().split("\n").length, 2);
  assert.ok(text.stdout.includes(`tent card take ${first.cardId} --role ${role.roleId}`));
  assert.match(text.stdout, /First line/);
  assert.deepEqual(await fileSnapshot(systemRoot), before);
});

test(
  "Card watch wakes across processes only when its Role gets input",
  { timeout: 45000 },
  async (t) => {
    const { root, globals } = await fixture(t);
    const role = value(await runRoleCommand("create", ["--title", "Watch"], globals));
    const other = value(await runRoleCommand("create", ["--title", "Other"], globals));
    const systemRoot = path.join(root, ".tent");
    const initialHead = (await historyHead(systemRoot)).trim();
    const beforeWatch = await fileSnapshot(systemRoot);
    const watchBudgetMs = 25000;
    const deadline = performance.now() + watchBudgetMs;
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        new URL("./fixtures/card-watch-observer.ts", import.meta.url).href,
        "src/cli/tent.ts",
        "card",
        "watch",
        "--role",
        role.roleId,
        "--timeout",
        String(watchBudgetMs / 1000),
        "--workspace",
        root,
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe", "ipc"] },
    );
    t.after(() => child.kill());
    assert.ok(child.stdout && child.stderr);
    let stdout = "",
      stderr = "",
      exited = false,
      closedAt = 0;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const done = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        exited = true;
        closedAt = performance.now();
        resolve(code);
      });
    });
    const idleCommits = new Set<string>();
    child.on("message", (message) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "event" in message &&
        message.event === "watch-idle" &&
        "commit" in message &&
        typeof message.commit === "string"
      )
        idleCommits.add(message.commit);
    });
    async function withinBudget<T>(pending: Promise<T>, description: string): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          pending,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Watch budget expired: ${description}\n${stderr || stdout}`)),
              Math.max(0, deadline - performance.now()),
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    async function observedIdle(commit: string) {
      if (idleCommits.has(commit)) return;
      let onMessage: () => void;
      const observed = new Promise<void>((resolve) => {
        onMessage = () => {
          if (idleCommits.has(commit)) resolve();
        };
        child.on("message", onMessage);
      });
      try {
        await withinBudget(
          Promise.race([
            observed,
            done.then((code) => {
              throw new Error(
                `Watch exited before observing ${commit}: ${code}\n${stderr || stdout}`,
              );
            }),
          ]),
          `idle after committed input ${commit}`,
        );
      } finally {
        child.off("message", onMessage!);
      }
    }
    await observedIdle(initialHead);
    assert.deepEqual(await fileSnapshot(systemRoot), beforeWatch);
    const unrelated = value(
      await runCardCommand("create", ["--prompt", "Other work", "--target", other.roleId], globals),
    );
    const unrelatedHead = (await historyHead(systemRoot)).trim();
    const afterUnrelated = await fileSnapshot(systemRoot);
    await observedIdle(unrelatedHead);
    assert.equal(exited, false, stderr || stdout);
    assert.equal(stdout, "");
    assert.deepEqual(await fileSnapshot(systemRoot), afterUnrelated);
    const card = value(
      await runCardCommand("create", ["--prompt", "Arrived", "--target", role.roleId], globals),
    );
    const published = performance.now();
    const afterPublished = await fileSnapshot(systemRoot);
    assert.equal(await withinBudget(done, "exact Role wake"), 0, stderr);
    assert.ok(closedAt - published < 6000, "should wake within one poll plus query time");
    assert.equal(stderr, "");
    assert.ok(stdout.includes(`tent card take ${card.cardId} --role ${role.roleId}`));
    assert.equal(stdout.trim().split("\n").length, 1);
    assert.equal(stdout.includes(unrelated.cardId), false);
    assert.deepEqual(await fileSnapshot(systemRoot), afterPublished);
    assert.equal(
      (await runCardCommand("watch", ["--role", role.roleId, "--timeout", "0"], globals)).exitCode,
      0,
    );
  },
);

async function fixture(t: TestContext) {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "card-cli-"));
  t.after(async () => {
    assert.equal(path.dirname(root), scratch);
    await removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });
  await scaffoldInWorkspace(openTestFs(root), { name: "Card CLI" });
  await initializeFixtureHistory(path.join(root, ".tent"));
  return { root, globals: { workspace: root, json: true } };
}
function value(result: { exitCode: number; stdout: string; stderr: string }) {
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function cardFile(root: string, cardId: string) {
  return path.join(root, ".tent", "cards", `${cardId}.md`);
}

test("Card list reads live headers and diagnostics without derived progress or capture", async (t) => {
  const { root, globals } = await fixture(t);
  const role = value(await runRoleCommand("create", ["--title", "Worker"], globals));
  const goal = value(
    await runNodeCommand("create", ["Goal", "--type", "goal", "--body", "Deliver"], globals),
  ).node;
  const card = value(
    await runCardCommand(
      "create",
      [
        "--title",
        "Recorded title",
        "--prompt",
        "Deliver",
        "--source",
        goal.nodeId,
        "--target",
        role.roleId,
      ],
      globals,
    ),
  );
  const adapter = openTestFs(path.join(root, ".tent"));
  const file = cardFile(root, card.cardId);
  const original = parseFrontmatter(await fs.readFile(file, "utf8"));
  const head = await adapter.history.currentCommit();
  const edited = serializeFrontmatter(
    { ...original.data, title: "Live title", state: "consumed", receivedBy: role.roleId },
    original.body,
    original.keyOrder,
  );
  await fs.writeFile(file, edited);
  const mtime = (await fs.stat(file)).mtimeMs;
  const listed = value(await runCardCommand("list", ["--state", "consumed"], globals));
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].title, "Live title");
  assert.equal(listed.items[0].state, "consumed");
  assert.equal("progress" in listed.items[0], false);
  assert.equal(listed.items[0].uncaptured, true);
  assert.equal(
    value(await runCardCommand("list", ["--state", "pending"], globals)).items.length,
    0,
  );
  assert.equal(await fs.readFile(file, "utf8"), edited);
  assert.equal((await fs.stat(file)).mtimeMs, mtime);

  const invalid = serializeFrontmatter(
    { ...original.data, schemaVersion: 999 },
    original.body,
    original.keyOrder,
  );
  await fs.writeFile(file, invalid);
  const invalidMtime = (await fs.stat(file)).mtimeMs;
  const unavailable = value(await runCardCommand("list", [], globals)).items[0];
  assert.match(unavailable.diagnostic, /header unavailable/);
  assert.equal(unavailable.title, undefined);
  assert.equal("progress" in unavailable, false);
  assert.equal(unavailable.uncaptured, true);
  const text = await runCardCommand("list", [], { workspace: root });
  assert.equal(text.exitCode, 0, text.stderr);
  assert.match(text.stdout, /header unavailable/);
  assert.match(text.stdout, /有未收录的改动/);
  assert.equal(await fs.readFile(file, "utf8"), invalid);
  assert.equal((await fs.stat(file)).mtimeMs, invalidMtime);
  assert.equal(await adapter.history.currentCommit(), head);
});

test("Card deprecate cancels a task, hides it from lists and marks a later take", async (t) => {
  const { root, globals } = await fixture(t);
  const role = value(await runRoleCommand("create", ["--title", "Worker"], globals));
  const card = value(
    await runCardCommand(
      "create",
      ["--prompt", "Read the requirements Node.", "--target", role.roleId],
      globals,
    ),
  );
  const cancelled = value(await runCardCommand("deprecate", [card.cardId], globals));
  assert.equal(cancelled.status, "deprecated");
  assert.equal(value(await runCardCommand("list", [], globals)).items.length, 0);
  assert.equal(
    value(await runCardCommand("list", ["--role", role.roleId], globals)).items.length,
    0,
  );
  assert.equal(
    value(await runCardCommand("list", ["--include-deprecated", "--state", "pending"], globals))
      .items[0].cardId,
    card.cardId,
  );
  const taken = value(await runCardCommand("take", [card.cardId, "--role", role.roleId], globals));
  assert.equal(taken.status, "deprecated");
  assert.equal(taken.state, "consumed");
  assert.equal(taken.text, "Read the requirements Node.");
  assert.match(taken.notice, /deprecated/);
  const text = await runCardCommand("take", [card.cardId, "--role", role.roleId], {
    workspace: root,
  });
  assert.match(text.stdout, /^This Card is deprecated; its task was cancelled\.$/m);
});

test("Card CLI help and invalid flags are handled before workspace or input access", async () => {
  const globals = { workspace: "Z:/missing-tent" };
  assert.equal((await runCardCommand("help", [], globals)).stdout, cardHelpText());
  for (const [sub, args] of [
    ["create", ["--prompt"]],
    ["create", ["--prompt", "work"]],
    ["list", ["--prompt=text"]],
    ["history", ["card-a"]],
    ["publish", ["card-a", "--base-etag", "hash"]],
    ["interrupt", ["card-a", "--commit", "hash"]],
    ["list", ["--include-drafts"]],
    ["list", ["--state", "interrupted"]],
    ["continue", ["card-a", "--role", "role-a"]],
    ["consume", ["card-a"]],
    ["show", ["card-a"]],
    ["move", ["card-a", "--to", "role-a"]],
    ["take", ["card-a"]],
    ["return", ["card-a"]],
    ["deprecate", ["card-a", "--base-etag", "hash"]],
    ["create", ["--pointer", "node:a"]],
  ] as const) {
    const result = await runCardCommand(sub, [...args], globals);
    assert.equal(result.exitCode, 1);
    assert.doesNotMatch(result.stderr, /Not inside a Tent/);
  }
  assert.match(
    (await runCardCommand("create", ["--prompt", "work"], globals)).stderr,
    /requires --target <role-id>/,
  );
});

test("Card CLI creates ordered sources and receives with its Role without Service", async (t) => {
  const { root, globals } = await fixture(t);
  const role = value(await runRoleCommand("create", ["--title", "Reviewer"], globals));
  const prompt = " \r\n\tKeep layout.  \n😀";
  const card = value(
    await runCardCommand(
      "create",
      [
        "--prompt",
        "-",
        "--source",
        "客户访谈结论",
        "--source",
        "https://example.invalid",
        "--target",
        role.roleId,
      ],
      { ...globals, stdin: prompt },
    ),
  );
  assert.equal(card.state, "pending");
  assert.equal(card.target, role.roleId);
  const stored = parseFrontmatter(await fs.readFile(cardFile(root, card.cardId), "utf8"));
  assert.deepEqual(
    (stored.data.sources as { resource: string }[]).map((s) => s.resource),
    ["客户访谈结论", "https://example.invalid"],
  );
  const taken = value(await runCardCommand("take", [card.cardId, "--role", role.roleId], globals));
  assert.equal(taken.state, "consumed");
  assert.equal(taken.replayed, false);
  assert.equal(taken.text, prompt);
  assert.deepEqual(taken.sources, [{ name: "客户访谈结论" }, { name: "https://example.invalid" }]);
  assert.equal(
    value(await runCardCommand("take", [card.cardId, "--role", role.roleId], globals)).replayed,
    true,
  );
  assert.equal((await fs.readdir(path.join(root, ".tent"))).includes("card-consumptions"), false);
});

test("Card sources are live addresses: create warns for unavailable sections and take follows a moved Node", async (t) => {
  const { root, globals } = await fixture(t);
  const role = value(await runRoleCommand("create", ["--title", "Worker"], globals));
  const create = (source: string) =>
    runCardCommand(
      "create",
      ["--prompt", "Work", "--target", role.roleId, "--source", source],
      globals,
    );
  const task = value(
    await runNodeCommand(
      "create",
      [
        "Task",
        "--type",
        "goal",
        "--body",
        "Opening.\n## Heading\nRequirement.\n## Repeat\none\n## Repeat\ntwo",
      ],
      globals,
    ),
  ).node;
  const validResponse = await create(`${task.nodeId}#Heading`);
  const valid = value(validResponse);
  assert.equal(validResponse.stderr, "");
  assert.deepEqual(
    parseFrontmatter(await fs.readFile(cardFile(root, valid.cardId), "utf8")).data.sources,
    [{ resource: "../Task/Task.md#Heading" }],
  );
  for (const [heading, warning] of [
    ["Missing", /selects an unavailable section/],
    ["Repeat", /heading is duplicated/],
  ] as const) {
    const response = await create(`${task.nodeId}#${heading}`);
    assert.equal(value(response).state, "pending");
    assert.match(response.stderr, warning);
    assert.ok(response.stderr.includes(`"${task.nodeId}#${heading}"`), response.stderr);
    assert.match(response.stderr, /the Card keeps it/);
  }
  const missingResponse = await create("./docs/missing.md");
  const missing = value(missingResponse);
  assert.match(missingResponse.stderr, /names no existing Workspace file/);

  value(await runNodeCommand("rename", [task.nodeId, "Moved"], globals));
  const taken = value(await runCardCommand("take", [valid.cardId, "--role", role.roleId], globals));
  assert.deepEqual(taken.sources, [
    { name: "Moved", path: `${path.join(root, ".tent", "Moved", "Moved.md")}#Heading` },
  ]);
  const text = await runCardCommand("take", [missing.cardId, "--role", role.roleId], {
    workspace: root,
  });
  assert.equal(text.exitCode, 0, text.stderr);
  assert.ok(
    text.stdout.endsWith(
      `\n\nSources:\n- docs/missing.md: ${path.join(root, "docs", "missing.md")} (not found)\n`,
    ),
    text.stdout,
  );
});
