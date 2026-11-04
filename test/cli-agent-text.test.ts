import { captureFixtureDocuments } from "./scratch.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";
import { initializeFixtureHistory } from "./scratch.js";
import { testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runNodeCommand, nodeHelpText } from "../src/cli/node-commands.js";
import { runCardCommand, cardHelpText } from "../src/cli/card-commands.js";
import { runRoleCommand } from "../src/cli/role-commands.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { pageItems } from "../src/cli/reader-page.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { createCardDocument, listCardDocuments } from "../src/core/graph/card-document.js";
import { createRoleContext } from "../src/core/read/role-context.js";

type Result = { exitCode: number; stdout: string; stderr: string };
const ok = (result: Result) => {
  assert.equal(result.exitCode, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /undefined|\[object Object\]/);
  return result.stdout;
};
const etag = (text: string) => {
  const value = /^ETag: (\S+)$/m.exec(text)?.[1];
  assert.ok(value, text);
  return value;
};

async function fixture(t: TestContext) {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "agent's text-"));
  t.after(async () => {
    assert.equal(path.dirname(root), scratch);
    await removeTestFixture(root, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 200,
    });
  });
  await scaffoldInWorkspace(root, {
    name: "Text",
    nodes: [
      { id: "node-goal", name: "Goal", type: "goal", body: "Goal body\n" },
      { id: "node-peer", name: "Peer", type: "prompt", body: "Peer body\n" },
    ],
  });
  await fs.writeFile(path.join(root, "peer.txt"), "peer material");
  const peerFile = path.join(root, ".tent/Peer/Peer.md");
  await fs.writeFile(
    peerFile,
    (await fs.readFile(peerFile, "utf8")).replace(
      "type: prompt",
      "type: prompt\nresource: ../../peer.txt",
    ),
  );
  await initializeFixtureHistory(path.join(root, ".tent"));
  await captureFixtureDocuments(path.join(root, ".tent"));
  const globals = { workspace: root };
  const node = (sub: string, args: string[]) => runNodeCommand(sub, args, globals);
  const card = (sub: string, args: string[]) => runCardCommand(sub, args, globals);
  const role = (sub: string, args: string[]) => runRoleCommand(sub, args, globals);
  const workspace = (sub: string, args: string[] = []) => runWorkspaceCommand(sub, args, globals);
  const next = async (failure: Result, expected: RegExp) => {
    assert.equal(failure.exitCode, 1);
    assert.equal(failure.stdout, "");
    const lines = failure.stderr.trimEnd().split("\n");
    const last = lines.at(-1)!;
    assert.match(last, /^Next: tent /);
    assert.match(last, expected, failure.stderr);
    assert.equal(lines.filter((line) => line.startsWith("Next:")).length, 1);
    // Decode the host shell's single-quoted arguments and execute the suggested command.
    const tokens =
      process.platform === "win32"
        ? last.slice(6).match(/'(?:[^']|'')*'|[^\s]+/g)!
        : last
            .slice(6)
            .replaceAll(`'"'"'`, "\u0000")
            .match(/'[^']*'|[^\s]+/g)!;
    const comment = tokens.indexOf("#");
    const words = (comment < 0 ? tokens : tokens.slice(0, comment)).map((word) =>
      process.platform === "win32"
        ? word.startsWith("'")
          ? word.slice(1, -1).replaceAll("''", "'")
          : word
        : (word.startsWith("'") ? word.slice(1, -1) : word).replaceAll("\u0000", "'"),
    );
    assert.equal(words.shift(), "tent");
    const group = words.shift()!,
      sub = words.shift()!;
    const run = { node, card, role, workspace }[group];
    assert.ok(run, last);
    return ok(await run(sub, words));
  };
  return {
    root,
    node,
    card,
    role,
    workspace,
    next,
    adapter: openTestFs(path.join(root, ".tent")),
  };
}

test("surviving text receipts identify Nodes, versions, Roles and Cards without replacing host file reads", async (t) => {
  const { root, node, card, role, workspace, adapter } = await fixture(t);
  const created = ok(
    await node("create", [
      "Child",
      "--id",
      "node-child",
      "--type",
      "prompt",
      "--parent",
      "node-goal",
      "--description",
      "Child facts",
      "--body",
      "## Facts\nChild body links [Peer](node-peer)",
    ]),
  );
  assert.match(created, /node-child/);
  const filename = path.join(root, ".tent/Goal/Child/Child.md");
  const original = await fs.readFile(filename, "utf8");
  assert.match(original, /Child body/);
  assert.match(original, /description: Child facts/);
  const versions = await node("history", ["node-child", "--json"]);
  const version = JSON.parse(ok(versions)).items[0].changes[0].after;
  ok(await node("rename", ["node-child", "Renamed"]));
  assert.equal(
    ok(await node("history", ["node-child", "--version", JSON.stringify(version)])),
    original,
  );
  const history = ok(await node("history", ["node-child"]));
  assert.ok(history.includes(version.commit));
  assert.match(history, /Goal\/Renamed\/Renamed\.md/);
  ok(await role("create", ["--id", "role-text", "--title", "Text Role", "--body", "Role body"]));
  const receipt = ok(
    await card("create", [
      "--id",
      "card-text",
      "--title",
      "Text Card",
      "--target",
      "role-text",
      "--prompt",
      "Card body",
    ]),
  );
  assert.match(receipt, /card-text/);
  assert.match(receipt, /target: role-text/);
  assert.match(receipt, /state: pending/);
  assert.doesNotMatch(receipt, /^\s*\{/);
  assert.match(await fs.readFile(path.join(root, ".tent/roles/role-text.md"), "utf8"), /Role body/);
  for (const [call, patterns] of [
    [() => card("list", []), [/card-text/, /Text Card/]],
    [() => card("list", ["--role", "role-text"]), [/card-text/, /Text Card/]],
    [() => card("watch", ["--role", "role-text", "--timeout", "0"]), [/card-text/, /Text Card/]],
    [
      () => card("take", ["card-text", "--role", "role-text"]),
      [/card-text/, /consumed/, /Replayed: false/, /Card body/],
    ],
    [() => card("take", ["card-text", "--role", "role-text"]), [/card-text/, /Replayed: true/]],
  ] as Array<[() => Promise<Result>, RegExp[]]>) {
    const text = ok(await call());
    for (const pattern of patterns) assert.match(text, pattern);
  }
  ok(await workspace("check"));
  assert.match(await adapter.readFile("Goal/Renamed/Renamed.md"), /Child body/);
  assert.match(cardHelpText(), /newest first/);
});

test("fixed-id creation refuses name/id collisions without overwriting and points to the existing Node", async (t) => {
  const { node, next, adapter } = await fixture(t);
  const args = ["Fixed", "--id", "node-fixed", "--type", "prompt", "--body", "Original"];
  assert.match(ok(await node("create", args)), /node-fixed/);
  const before = await adapter.readFile("Fixed/Fixed.md"),
    head = await adapter.history.currentCommit();
  await next(await node("create", args), /node history node-fixed/);
  await next(
    await node("create", [
      "Fixed",
      "--id",
      "node-other",
      "--type",
      "prompt",
      "--body",
      "Overwrite",
    ]),
    /node history node-fixed/,
  );
  await next(
    await node("create", ["Other", "--id", "node-fixed", "--type", "prompt"]),
    /node history node-fixed/,
  );
  assert.equal(await adapter.readFile("Fixed/Fixed.md"), before);
  assert.equal(await adapter.exists("Other"), false);
  assert.equal(await adapter.history.currentCommit(), head);
  ok(
    await node("create", [
      "Fixed",
      "--id",
      "node-nested",
      "--parent",
      "node-goal",
      "--type",
      "prompt",
    ]),
  );
});

test("unknown identities, invalid input and wrong Role errors end in a single runnable Next command", async (t) => {
  const { node, card, role, next } = await fixture(t);
  ok(await role("create", ["--id", "role-target", "--title", "Target"]));
  ok(await role("create", ["--id", "role-other", "--title", "Other"]));
  for (const [call, pattern] of [
    [() => role("delete", ["role-missing"]), /role --help/],
    [() => node("create", ["Bad", "--type", "unknown"]), /node create --help/],
    [() => node("create", ["CON", "--type", "prompt"]), /node create --help/],
  ] as Array<[() => Promise<Result>, RegExp]>)
    await next(await call(), pattern);
  ok(await card("create", ["--id", "card-target", "--target", "role-target", "--prompt", "Work"]));
  const missingCard = await card("take", ["card-missing", "--role", "role-target"]);
  assert.equal(missingCard.stderr.split("\n")[0], "Card not found: card-missing.");
  await next(missingCard, /card list/);
  await next(await card("take", ["card-target", "--role", "role-other"]), /card list/);
});

test("unknown subcommands preserve the command diagnosis and leave existing Cards and Roles unchanged", async (t) => {
  const { node, card, role, workspace, next, adapter } = await fixture(t);
  ok(await role("create", ["--id", "role-existing", "--title", "Existing role"]));
  ok(
    await card("create", [
      "--id",
      "card-existing",
      "--target",
      "role-existing",
      "--prompt",
      "Existing card",
    ]),
  );
  const before = await adapter.readFile("cards/card-existing.md");
  const beforeRole = await adapter.readFile("roles/role-existing.md");
  const head = await adapter.history.currentCommit();
  for (const [group, run, args, required] of [
    ["node", node, ["node-peer"], ["create", "history"]],
    ["card", card, ["card-existing"], ["create", "take", "return"]],
    ["role", role, ["role-existing"], ["create", "delete"]],
    ["workspace", workspace, [], ["check", "scan"]],
  ] as const) {
    const failed = await run("frob", [...args]);
    const lines = failed.stderr.trimEnd().split("\n");
    assert.equal(lines[0], `Unknown command: tent ${group} frob`);
    assert.match(lines[1]!, /^Commands: /);
    for (const sub of required) assert.ok(lines[1]!.split(" ").includes(sub));
    assert.equal(lines.length, 3, failed.stderr);
    assert.doesNotMatch(failed.stderr, /not found|Usage:/i);
    await next(failed, new RegExp(`^Next: tent ${group} --help`));
  }
  assert.equal(await adapter.readFile("cards/card-existing.md"), before);
  assert.equal(await adapter.readFile("roles/role-existing.md"), beforeRole);
  assert.equal(await adapter.history.currentCommit(), head);
});

test("unknown top-level commands show one command list and runnable help", async () => {
  const error = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "src/cli/tent.ts", "frob"],
    { windowsHide: true },
  ).then(
    () => assert.fail("Unknown command succeeded"),
    (error: { code: number; stdout: string; stderr: string }) => error,
  );
  assert.equal(error.code, 1);
  assert.equal(error.stdout, "");
  assert.equal(
    error.stderr.trimEnd(),
    "Unknown command: tent frob\nCommands: new load node card role workspace hook\nNext: tent --help",
  );
  const help = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "src/cli/tent.ts", "--help"],
    {
      windowsHide: true,
    },
  );
  assert.match(help.stdout, /^Tent keeps the context of your project's agent sessions/);
});

test("missing Nodes have a short diagnosis and runnable graph inspection without writes", async (t) => {
  const { node, next, adapter } = await fixture(t);
  const head = await adapter.history.currentCommit();
  for (const [sub, args] of [
    ["rename", ["node-missing", "Missing"]],
    ["archive", ["node-missing"]],
  ] as const) {
    const failed = await node(sub, [...args]);
    assert.equal(failed.stderr.split("\n")[0], "Node not found: node-missing.");
    assert.doesNotMatch(failed.stderr, /Error:|ENOENT|not readable/);
    await next(failed, /^Next: tent workspace check /);
  }
  assert.equal(await adapter.history.currentCommit(), head);
});

test("missing Roles in Card flags hide system diagnostics and point to role help", async (t) => {
  const { root, card, role, next, adapter } = await fixture(t);
  ok(await role("create", ["--id", "role-real", "--title", "Real"]));
  ok(
    await card("create", [
      "--id",
      "card-existing",
      "--target",
      "role-real",
      "--prompt",
      "Existing",
    ]),
  );
  const head = await adapter.history.currentCommit();
  for (const call of [
    () => role("delete", ["role-missing"]),
    () => card("create", ["--prompt", "Work", "--target", "role-missing"]),
    () =>
      card("create", ["--prompt", "Work", "--target", "role-real", "--return-to", "role-missing"]),
    () => card("take", ["card-existing", "--role", "role-missing"]),
    () => card("return", ["card-existing", "--role", "role-missing", "--result", "Done"]),
    () => card("watch", ["--role", "role-missing", "--timeout", "0"]),
    () => card("list", ["--role", "role-missing"]),
  ]) {
    const failed = await call();
    const diagnosis = failed.stderr.split("\n")[0]!;
    assert.equal(diagnosis, "Role not found: role-missing.");
    assert.doesNotMatch(diagnosis, /Error:|ENOENT|stat|roles[\\/]/);
    assert.equal(diagnosis.includes(root), false);
    await next(failed, /^Next: tent role --help /);
  }
  assert.equal(await adapter.history.currentCommit(), head);
});

test("deprecated Roles are identified without system diagnostics in Card flags", async (t) => {
  const { root, card, role, next, adapter } = await fixture(t);
  ok(await role("create", ["--id", "role-real", "--title", "Real"]));
  ok(await role("create", ["--id", "role-retired", "--title", "Retired"]));
  const file = path.join(root, ".tent/roles/role-retired.md");
  await fs.writeFile(
    file,
    (await fs.readFile(file, "utf8")).replace("type: role\n", "type: role\nstatus: deprecated\n"),
  );
  const head = await adapter.history.currentCommit();
  for (const call of [
    () => card("create", ["--prompt", "Work", "--target", "role-retired"]),
    () =>
      card("create", ["--prompt", "Work", "--target", "role-real", "--return-to", "role-retired"]),
    () => card("watch", ["--role", "role-retired", "--timeout", "0"]),
    () => card("list", ["--role", "role-retired"]),
  ]) {
    const failed = await call();
    assert.equal(failed.stderr.split("\n")[0], "Role role-retired is deprecated.");
    assert.doesNotMatch(failed.stderr, /Error:|Role unavailable|not current|ENOENT/);
    await next(failed, /^Next: tent role --help /);
  }
  assert.equal(await adapter.history.currentCommit(), head);
});

test("Node help exposes only creation, structural changes and historical reads", () => {
  const help = nodeHelpText();
  for (const sub of ["create", "rename", "move", "archive", "delete", "history"])
    assert.match(help, new RegExp(`tent node ${sub} `));
  assert.match(nodeHelpText("create"), /--description/);
  assert.match(nodeHelpText("create"), /--resource/);
  assert.match(nodeHelpText("create"), /--source/);
  assert.match(nodeHelpText("create"), /--draft/);
  assert.match(nodeHelpText("history"), /--version/);
  assert.doesNotMatch(
    help,
    /tent node (?:get|list|read-many|search|relations|tags|append|write|write-many|link-output)(?: |$)/,
  );
});

test("real lock timeout gives a runnable inspection command without creating the requested Node", async (t) => {
  const { node, next, adapter } = await fixture(t);
  let acquired!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => (acquired = resolve));
  const held = new Promise<void>((resolve) => (release = resolve));
  const holder = adapter.withLock(async () => {
    acquired();
    await held;
  });
  await ready;
  let result: Result;
  try {
    result = await node("create", ["Busy", "--type", "prompt"]);
  } finally {
    release();
    await holder;
  }
  assert.match(result.stderr, /still busy after waiting 8 seconds/);
  await next(result, /workspace check/);
  assert.equal(await adapter.exists("Busy"), false);
});

test("Next is directly executable by the host shell when the workspace contains spaces and an apostrophe", async (t) => {
  const { card, role } = await fixture(t);
  ok(await role("create", ["--id", "role-shell", "--title", "Shell role"]));
  ok(
    await card("create", [
      "--id",
      "card-shell",
      "--title",
      "Shell card",
      "--target",
      "role-shell",
      "--prompt",
      "Work",
    ]),
  );
  const failure = await card("take", ["card-missing", "--role", "role-shell"]);
  const next = failure.stderr
    .trimEnd()
    .split("\n")
    .at(-1)!
    .replace(/^Next: /, "");
  const windows = process.platform === "win32";
  const define = windows
    ? "function tent { & $env:TENT_TEST_NODE --import tsx $env:TENT_TEST_ENTRY @args }; "
    : 'tent() { "$TENT_TEST_NODE" --import tsx "$TENT_TEST_ENTRY" "$@"; }; ';
  const { stdout, stderr } = await promisify(execFile)(
    windows ? "pwsh" : "/bin/sh",
    windows ? ["-NoProfile", "-NonInteractive", "-Command", define + next] : ["-c", define + next],
    {
      windowsHide: true,
      env: {
        ...process.env,
        TENT_TEST_NODE: process.execPath,
        TENT_TEST_ENTRY: path.resolve("src/cli/tent.ts"),
      },
    },
  );
  assert.equal(stderr, "");
  assert.match(stdout, /card-shell.*Shell card/);
});

for (const state of [undefined, "pending"] as const) {
  test(`Card ${state ?? "publication"} order is applied before filtering/pagination with stable equal-time ties and revision checks`, async (t) => {
    const { adapter } = await fixture(t);
    await createRoleContext(adapter, { roleId: "role-sort", title: "Sort" });
    for (const cardId of ["card-zold", "card-bnew", "card-anew"])
      await createCardDocument(adapter, {
        cardId,
        prompt: cardId,
        target: "role-sort",
      });
    const times = new Map([
      ["cards/card-zold.md", "2026-01-01T00:00:00.000Z"],
      ["cards/card-bnew.md", "2026-02-01T00:00:00.000Z"],
      ["cards/card-anew.md", "2026-02-01T00:00:00.000Z"],
    ]);
    t.mock.method(adapter.history, "firstCommitTimes", async () => times);
    const filter = { roleId: "role-sort", state };
    const expected =
      state === "pending"
        ? ["card-zold", "card-anew", "card-bnew"]
        : ["card-anew", "card-bnew", "card-zold"];
    const listed = await listCardDocuments(adapter, filter);
    assert.deepEqual(
      listed.items.map((item) => item.cardId),
      expected,
    );
    const first = pageItems(listed.items.slice(0, 1), 0, listed.items.length);
    assert.equal(first.items[0]!.cardId, expected[0]);
    assert.equal(first.page.next, 1);
    const second = pageItems(listed.items.slice(1, 2), 1, listed.items.length);
    assert.equal(second.items[0]!.cardId, expected[1]);
    await createCardDocument(adapter, {
      cardId: "card-latest",
      prompt: "Latest",
      target: "role-sort",
    });
    times.set("cards/card-latest.md", "2026-03-01T00:00:00.000Z");
    const changed = await listCardDocuments(adapter, filter);
    assert.deepEqual(
      changed.items.map((item) => item.cardId),
      state === "pending" ? [...expected, "card-latest"] : ["card-latest", ...expected],
    );
  });
}
