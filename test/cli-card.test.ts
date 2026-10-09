import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { spawn } from "node:child_process";
import { runCardCommand, cardHelpText } from "../src/cli/card-commands.js";
import { runRoleCommand } from "../src/cli/role-commands.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { git } from "./helpers.js";

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
  assert.match(cardHelpText("watch"), /2 = timeout \(no output\); 1 = error/);
});

test("Card watch returns only committed current pending input for the exact Role", async (t) => {
  const { root, globals } = await fixture(t);
  const role = value(await runRoleCommand("create", ["--title", "Watch"], globals));
  const other = value(await runRoleCommand("create", ["--title", "Other"], globals));
  const create = (title: string, target?: string) =>
    runCardCommand(
      "create",
      ["--prompt", "Work", "--title", title, ...(target ? ["--target", target] : [])],
      globals,
    ).then(value);
  await create("Public");
  await create("Other", other.roleId);
  const consumed = await create("Consumed", role.roleId);
  value(await runCardCommand("take", [consumed.cardId, "--role", role.roleId], globals));
  const cancelled = await create("Cancelled", role.roleId);
  value(
    await runCardCommand("deprecate", [cancelled.cardId, "--base-etag", cancelled.etag], globals),
  );
  const first = await create("First\nline", role.roleId);
  const second = await create("Second", role.roleId);
  const systemRoot = path.join(root, ".tent");
  const unpublished = (await fs.readFile(path.join(systemRoot, first.path), "utf8")).replaceAll(
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
    const initialHead = (await git(systemRoot, "rev-parse", "HEAD")).trim();
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
    const unrelatedHead = (await git(systemRoot, "rev-parse", "HEAD")).trim();
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
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "card-cli-"));
  t.after(async () => {
    assert.equal(path.dirname(root), scratch);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });
  await scaffoldInWorkspace(new NodeFs(root), { name: "Card CLI" });
  await git(path.join(root, ".tent"), "init");
  return { root, globals: { workspace: root, json: true } };
}
function value(result: { exitCode: number; stdout: string; stderr: string }) {
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("Card CLI deprecates tasks with CAS, filters them and displays a reception notice", async (t) => {
  const { root, globals } = await fixture(t);
  const card = value(
    await runCardCommand("create", ["--prompt", "Read the requirements Node."], globals),
  );
  const adapter = new NodeFs(path.join(root, ".tent"));
  const before = await adapter.readFile(card.path);
  assert.equal((await runCardCommand("deprecate", [card.cardId], globals)).exitCode, 1);
  assert.equal(
    (await runCardCommand("deprecate", [card.cardId, "--base-etag", "stale"], globals)).exitCode,
    1,
  );
  assert.equal(await adapter.readFile(card.path), before);
  const cancelled = value(
    await runCardCommand("deprecate", [card.cardId, "--base-etag", card.etag], globals),
  );
  assert.equal(cancelled.status, "deprecated");
  assert.equal(value(await runCardCommand("list", [], globals)).items.length, 0);
  assert.equal(
    value(await runCardCommand("list", ["--include-deprecated", "--state", "pending"], globals))
      .items[0].cardId,
    card.cardId,
  );
  const shown = value(await runCardCommand("show", [card.cardId], globals));
  assert.equal(shown.text, "Read the requirements Node.");
  assert.match(shown.notice, /deprecated/);
  assert.deepEqual(shown.currentReferences, []);
  const taken = value(await runCardCommand("take", [card.cardId], globals));
  assert.equal(taken.status, "deprecated");
  assert.equal(taken.state, "consumed");
  assert.match(
    (await runCardCommand("show", [card.cardId], { workspace: root })).stdout,
    /deprecated/,
  );
});

test("Card CLI supports an ordinary Session without creating a Role", async (t) => {
  const { root, globals } = await fixture(t);
  const card = value(await runCardCommand("create", ["--prompt", "do this"], globals));
  const taken = value(await runCardCommand("take", [card.cardId], globals));
  assert.equal(taken.state, "consumed");
  assert.equal(taken.receivedBy, undefined);
  assert.equal(value(await runRoleCommand("list", [], globals)).items.length, 0);
});

test("Card CLI help and invalid flags are handled before workspace or input access", async () => {
  const globals = { workspace: "Z:/missing-tent" };
  assert.equal((await runCardCommand("help", [], globals)).stdout, cardHelpText());
  for (const [sub, args] of [
    ["create", ["--prompt"]],
    ["list", ["--prompt=text"]],
    ["history", ["card-a"]],
    ["publish", ["card-a", "--base-etag", "hash"]],
    ["interrupt", ["card-a", "--commit", "hash"]],
    ["list", ["--include-drafts"]],
    ["list", ["--state", "interrupted"]],
    ["continue", ["card-a", "--role", "role-a"]],
    ["consume", ["card-a"]],
    ["return", ["card-a"]],
    ["create", ["--pointer", "node:a"]],
    ["move", ["card-a", "--public"]],
    ["move", ["card-a", "--public", "--to", "role-a", "--base-etag", "hash"]],
  ] as const) {
    const result = await runCardCommand(sub, [...args], globals);
    assert.equal(result.exitCode, 1);
    assert.doesNotMatch(result.stderr, /Not inside a Tent/);
  }
});

test("Card CLI moves pending input and locks the target at reception", async (t) => {
  const { root, globals } = await fixture(t);
  const role = value(await runRoleCommand("create", ["--title", "Reviewer"], globals));
  const card = value(await runCardCommand("create", ["--prompt", "Review"], globals));
  const moved = value(
    await runCardCommand(
      "move",
      [card.cardId, "--to", role.roleId, "--base-etag", card.etag],
      globals,
    ),
  );
  assert.equal(moved.target, role.roleId);
  const opened = value(
    await runCardCommand("move", [card.cardId, "--public", "--base-etag", moved.etag], globals),
  );
  assert.equal(opened.target, null);
  assert.equal(value(await runCardCommand("list", [], globals)).items.length, 1);
  value(await runCardCommand("take", [card.cardId], globals));
  assert.equal(
    (
      await runCardCommand(
        "move",
        [card.cardId, "--to", role.roleId, "--base-etag", opened.etag],
        globals,
      )
    ).exitCode,
    1,
  );
});

test("Card CLI creates ordered sources, previews and receives with an explicit Role without Service", async (t) => {
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
        JSON.stringify({ resource: "https://example.invalid", custom: { preserve: true } }),
        "--target",
        role.roleId,
      ],
      { ...globals, stdin: prompt },
    ),
  );
  const preview = value(await runCardCommand("get", [card.cardId], globals));
  assert.equal(preview.text, prompt);
  assert.equal(preview.state, "pending");
  assert.deepEqual(
    preview.sources.map((s: { resource: string }) => s.resource),
    ["客户访谈结论", "https://example.invalid"],
  );
  const taken = value(await runCardCommand("take", [card.cardId, "--role", role.roleId], globals));
  assert.equal(taken.state, "consumed");
  assert.equal(taken.replayed, false);
  assert.equal(
    value(await runCardCommand("take", [card.cardId, "--role", role.roleId], globals)).replayed,
    true,
  );
  assert.equal((await fs.readdir(path.join(root, ".tent"))).includes("card-consumptions"), false);
});
