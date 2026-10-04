import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { runCardCommand, cardHelpText } from "../src/cli/card-commands.js";
import { runRoleCommand } from "../src/cli/role-commands.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { git } from "./helpers.js";

async function fixture(t: TestContext) {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "card-cli-"));
  t.after(async () => {
    assert.equal(path.dirname(root), scratch);
    await fs.rm(root, { recursive: true, force: true });
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
