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
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { createCardDocument, listCardDocuments } from "../src/core/card-document.js";
import { createRoleContext } from "../src/core/role-context.js";
import { MUTATION_LOCK_PATH } from "../src/core/paths.js";
import { git } from "./helpers.js";
import { cliErrorText } from "../src/cli/error-text.js";
import { NodeWriteError } from "../src/core/node-document-write.js";

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
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "agent's text-"));
  t.after(async () => {
    assert.equal(path.dirname(root), scratch);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });
  await scaffoldInWorkspace(new NodeFs(root), {
    name: "Text",
    nodes: [
      { id: "node-goal", name: "Goal", type: "goal", body: "Goal body\n" },
      { id: "node-peer", name: "Peer", type: "prompt", body: "Peer body\n" },
    ],
  });
  await git(path.join(root, ".tent"), "init");
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
  return { root, node, card, role, workspace, next, adapter: new NodeFs(path.join(root, ".tent")) };
}

test("text lists/details identify their objects, body reads preserve text, and all relation directions describe endpoints", async (t) => {
  const { root, node, card, role, workspace } = await fixture(t);
  ok(
    await node("create", [
      "Child",
      "--id",
      "node-child",
      "--type",
      "prompt",
      "--parent",
      "node-goal",
      "--body",
      "## Facts\nChild body links [Peer](node-peer)",
    ]),
  );
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
  for (const [call, patterns] of [
    [() => node("list", []), [/node-goal/, /Goal/, /node-peer/, /Peer/]],
    [() => node("list", ["--full"]), [/node-child/, /Child/]],
    [() => node("get", ["node-child"]), [/node-child/, /Child/, /Child body/]],
    [() => node("get", ["node-child", "--full"]), [/node-child/, /Child/, /Child body/]],
    [() => node("get", ["node-child", "--view", "summary"]), [/node-child/, /Child/]],
    [() => node("get", ["node-child", "--view", "raw", "--full"]), [/node-child/, /Child body/]],
    [() => node("history", ["node-child"]), [/node-child/, /Child\/Child.md/]],
    [() => node("check", ["node-child"]), [/node-child/, /Child/]],
    [
      () => node("read-many", ["node-child", "node-peer"]),
      [/node-child/, /node-peer/, /Child body/, /Peer body/],
    ],
    [() => node("search", ["Peer"]), [/node-peer/, /Peer/]],
    [
      () => node("relations", ["node-child", "--direction", "parent"]),
      [/parent  /, /node-goal/, /Goal/],
    ],
    [
      () => node("relations", ["node-goal", "--direction", "children"]),
      [/children  /, /node-child/, /Child/],
    ],
    [
      () => node("relations", ["node-child", "--direction", "outgoing"]),
      [/link/, /node-peer/, /Peer/],
    ],
    [
      () => node("relations", ["node-peer", "--direction", "incoming"]),
      [/link/, /node-child/, /Child/],
    ],
    [() => role("list", []), [/role-text/, /Text Role/]],
    [() => role("show", ["role-text"]), [/role-text/, /roles\/role-text.md/, /Role body/, /ETag:/]],
    [() => card("list", []), [/card-text/, /Text Card/]],
    [
      () => card("show", ["card-text"]),
      [/card-text/, /Text Card/, /Card body/, /Target: role-text/, /ETag:/],
    ],
    [() => card("get", ["card-text"]), [/card-text/, /Text Card/, /Card body/]],
    [() => card("watch", ["--role", "role-text", "--timeout", "0"]), [/card-text/, /Text Card/]],
    [
      () => card("take", ["card-text", "--role", "role-text"]),
      [/card-text/, /consumed/, /Replayed: false/],
    ],
    [() => card("take", ["card-text", "--role", "role-text"]), [/card-text/, /Replayed: true/]],
    [() => node("get-section", ["node-child", "--heading", "Facts"]), [/node-child/, /## Facts/]],
    [() => workspace("changes"), [/node-child/]],
  ] as Array<[() => Promise<Result>, RegExp[]]>) {
    const text = ok(await call());
    for (const pattern of patterns) assert.match(text, pattern);
  }
  await fs.writeFile(path.join(root, "input.md"), "Before\n");
  ok(
    await node("create", [
      "Material",
      "--id",
      "node-material",
      "--type",
      "prompt",
      "--resource",
      "input.md",
      "--body",
      "material fact",
    ]),
  );
  await fs.writeFile(path.join(root, "input.md"), "After\n");
  const drift = ok(await workspace("drift"));
  assert.match(drift, /behind  node-material  \.tent\/Material\/Material.md  /);
  assert.match(drift, /Material changed:/);
  ok(await workspace("brief"));
  ok(await workspace("check"));
  ok(await node("tags", []));
  assert.match(cardHelpText(), /newest first/);
});

test("complete first-page ETags authorize writes and confirmations; partial and stale bases fail with runnable recovery commands", async (t) => {
  const { node, next, adapter } = await fixture(t);
  const first = etag(ok(await node("get", ["node-peer"])));
  assert.doesNotMatch(first, /^read:/);
  ok(await node("write", ["node-peer", "--body", "Changed body", "--base-etag", first]));
  const completeRaw = etag(ok(await node("get", ["node-peer", "--view", "raw"])));
  assert.doesNotMatch(completeRaw, /^read:/);
  ok(await node("confirm", ["node-peer", "--base-etag", completeRaw]));
  await next(
    await node("write", ["node-peer", "--body", "Stale", "--base-etag", first]),
    /node get node-peer --full/,
  );
  ok(
    await node("create", [
      "Long",
      "--id",
      "node-long",
      "--type",
      "prompt",
      "--body",
      "long text ".repeat(4000),
    ]),
  );
  const partial = etag(ok(await node("get", ["node-long"])));
  assert.match(partial, /^read:/);
  const before = await adapter.readFile("Long/Long.md");
  const head = await adapter.history.currentCommit();
  await next(
    await node("write", ["node-long", "--body", "Incomplete", "--base-etag", partial]),
    /node get node-long --full/,
  );
  await next(
    await node("confirm", ["node-long", "--base-etag", partial]),
    /node get node-long --full/,
  );
  assert.equal(await adapter.readFile("Long/Long.md"), before);
  assert.equal(await adapter.history.currentCommit(), head);
  assert.match(nodeHelpText("get"), /A page that holds the complete body returns the full ETag/);
});

test("fixed-id creation refuses name/id collisions without overwriting and points to the existing Node", async (t) => {
  const { node, next, adapter } = await fixture(t);
  const args = ["Fixed", "--id", "node-fixed", "--type", "prompt", "--body", "Original"];
  assert.match(ok(await node("create", args)), /node-fixed/);
  const before = await adapter.readFile("Fixed/Fixed.md"),
    head = await adapter.history.currentCommit();
  await next(await node("create", args), /node get node-fixed --full/);
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
    /node get node-fixed --full/,
  );
  await next(
    await node("create", ["Other", "--id", "node-fixed", "--type", "prompt"]),
    /node get node-fixed --full/,
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

test("unknown identities, invalid input, missing material and wrong Role errors end in a single runnable Next command", async (t) => {
  const { node, card, role, next } = await fixture(t);
  for (const [call, pattern] of [
    [() => node("get", ["node-missing"]), /node list --full/],
    [() => card("show", ["card-missing"]), /card list/],
    [() => role("show", ["role-missing"]), /role list/],
    [() => node("create", ["Bad", "--type", "unknown"]), /node create --help/],
    [() => node("create", ["CON", "--type", "prompt"]), /node create --help/],
    [
      () => node("link-output", ["node-goal", "--resource", "./missing.txt"]),
      /node link-output --help/,
    ],
  ] as Array<[() => Promise<Result>, RegExp]>)
    await next(await call(), pattern);
  ok(await role("create", ["--id", "role-target", "--title", "Target"]));
  ok(await role("create", ["--id", "role-other", "--title", "Other"]));
  ok(await card("create", ["--id", "card-target", "--target", "role-target", "--prompt", "Work"]));
  const missingCard = await card("show", ["card-missing"]);
  assert.equal(missingCard.stderr.split("\n")[0], "Card not found: card-missing.");
  await next(missingCard, /card list/);
  await next(await card("take", ["card-target", "--role", "role-other"]), /card show card-target/);
});

test("recovery targets come from parsed command operands, not ID-like body or name values", async (t) => {
  const { node, role, next, adapter } = await fixture(t);
  const oldNode = etag(ok(await node("get", ["node-peer"])));
  ok(await node("append", ["node-peer", "--body", "Latest target body"]));
  ok(await role("create", ["--id", "role-target", "--title", "Target", "--body", "Role body"]));
  const oldRole = etag(ok(await role("show", ["role-target"])));
  ok(await role("write", ["role-target", "--body", "Latest role body", "--base-etag", oldRole]));
  // A full-list recovery may capture previously unread scaffold Nodes. Establish that read first.
  ok(await node("list", ["--full"]));
  const before = await adapter.readFile("Peer/Peer.md");
  const beforeRole = await adapter.readFile("roles/role-target.md");
  const head = await adapter.history.currentCommit();
  for (const args of [
    ["node-peer", "--body", "node-goal"],
    ["--body", "node-goal", "node-peer"],
    ["--body=node-goal", "node-peer"],
  ]) {
    const recovered = await next(
      await node("write", [...args, "--base-etag", oldNode]),
      /^Next: tent node get node-peer --full /,
    );
    assert.match(recovered, /^node-peer\nETag: /);
    assert.match(recovered, /Latest target body/);
    assert.doesNotMatch(recovered, /Goal body/);
  }
  for (const args of [
    ["role-target", "--body", "node-goal"],
    ["--body=node-goal", "role-target"],
  ]) {
    const recovered = await next(
      await role("write", [...args, "--base-etag", oldRole]),
      /^Next: tent role show role-target /,
    );
    assert.match(recovered, /^role-target\s+\.tent\/roles\/role-target\.md$/m);
    assert.match(recovered, /Latest role body/);
    assert.doesNotMatch(recovered, /Goal body/);
  }
  for (const args of [
    ["node-goal", "--parent", "node-missing"],
    ["--parent=node-missing", "node-goal"],
  ]) {
    const failed = await node("create", [...args, "--type", "prompt"]);
    assert.equal(failed.stderr.split("\n")[0], "Node not found: node-missing.");
    await next(failed, /^Next: tent node list --full /);
  }
  assert.equal(await adapter.exists("node-goal"), false);
  assert.equal(await adapter.readFile("Peer/Peer.md"), before);
  assert.equal(await adapter.readFile("roles/role-target.md"), beforeRole);
  assert.equal(await adapter.history.currentCommit(), head);
});

test("unknown subcommands preserve the command diagnosis and leave existing Cards and Roles unchanged", async (t) => {
  const { card, role, next, adapter } = await fixture(t);
  ok(await card("create", ["--id", "card-existing", "--prompt", "Existing card"]));
  ok(await role("create", ["--id", "role-existing", "--title", "Existing role"]));
  const before = await adapter.readFile("cards/card-existing.md");
  const beforeRole = await adapter.readFile("roles/role-existing.md");
  const head = await adapter.history.currentCommit();
  const failed = await card("interrupt", ["card-existing"]);
  assert.equal(failed.stderr.split("\n")[0], "Unknown card command: interrupt");
  assert.doesNotMatch(failed.stderr, /not found/i);
  assert.match(await next(failed, /^Next: tent card --help/), /tent card show card-ID/);
  const failedRole = await role("interrupt", ["role-existing"]);
  assert.equal(failedRole.stderr.split("\n")[0], "Unknown role subcommand: interrupt");
  assert.match(await next(failedRole, /^Next: tent role --help/), /tent role show role-ID/);
  assert.match(ok(await card("show", ["card-existing"])), /Existing card/);
  assert.match(
    ok(await role("show", ["role-existing"])),
    /^role-existing\s+\.tent\/roles\/role-existing\.md$/m,
  );
  assert.equal(await adapter.readFile("cards/card-existing.md"), before);
  assert.equal(await adapter.readFile("roles/role-existing.md"), beforeRole);
  assert.equal(await adapter.history.currentCommit(), head);
});

test("judge W1-W4 wording is exact, Next runs, and text conflicts do not expose JSON read bases", async (t) => {
  const { root, node, next, adapter } = await fixture(t);
  const workspaceArg =
    process.platform === "win32"
      ? `'${root.replaceAll("'", "''")}'`
      : `'${root.replaceAll("'", `'"'"'`)}'`;
  const nextLine = (command: string) => `Next: tent node ${command} --workspace ${workspaceArg}`;
  ok(await node("list", ["--full"]));
  const first = etag(ok(await node("get", ["node-peer"])));
  ok(await node("write", ["node-peer", "--body", "Current text", "--base-etag", first]));
  const current = etag(ok(await node("get", ["node-peer"])));
  const before = await adapter.readFile("Peer/Peer.md");
  const head = await adapter.history.currentCommit();
  const args = ["node-peer", "--body", "Stale text", "--base-etag", first];
  const stale = await node("write", args);
  assert.equal(
    stale.stderr,
    `Node node-peer changed after your read: etag ${first} is stale.\n${nextLine("get node-peer --full")}\n`,
  );
  await next(stale, /node get node-peer --full/);
  const jsonStale = await node("write", [...args, "--json"]);
  assert.equal(jsonStale.exitCode, 1);
  assert.equal(jsonStale.stderr.split("\n")[0], "etag conflict");
  const details = JSON.parse(jsonStale.stderr.split("\n")[1]!);
  assert.equal(details.nodeId, "node-peer");
  assert.equal(details.baseEtag, first);
  assert.equal(details.currentEtag, `read:${current}`);
  assert.equal(
    cliErrorText(new NodeWriteError("ETAG_CONFLICT", "etag conflict"), "tent node write", {
      target: { kind: "node", id: "node-peer" },
      workspace: root,
    }),
    `The Node changed after your read; its etag is stale.\n${nextLine("get node-peer --full")}`,
  );
  const partial = etag(
    ok(await node("get", ["node-peer", "--range", '{"unit":"utf16","start":0,"end":2}'])),
  );
  assert.match(partial, /^read:/);
  const incomplete = await node("write", ["node-peer", "--body", "Lost", "--base-etag", partial]);
  assert.equal(
    incomplete.stderr,
    `A read: ETag comes from a partial read and allows metadata edits only.\n${nextLine("get node-peer --full")}\n`,
  );
  await next(incomplete, /node get node-peer --full/);
  const confirm = await node("confirm", ["node-peer", "--base-etag", partial]);
  assert.equal(
    confirm.stderr,
    `Confirmation requires a complete live Node read.\n${nextLine("get node-peer --full")}\n`,
  );
  await next(confirm, /node get node-peer --full/);
  for (const [sub, input] of [
    ["create", ["Bad type", "--type", "decision"]],
    ["type", ["node-peer", "decision", "--base-etag", current]],
    [
      "write-many",
      [
        "--input-json",
        JSON.stringify({
          items: [{ op: "create", ref: "bad", name: "Bad type", type: "evidence" }],
        }),
      ],
    ],
  ] as const) {
    const failed = await node(sub, [...input]);
    assert.equal(
      failed.stderr,
      `Node type must be goal, prompt or output.\n${nextLine(`${sub} --help`)}  # words like decision or evidence go in --tags\n`,
    );
    await next(failed, new RegExp(`node ${sub} --help`));
  }
  const missing = await node("link-output", ["node-goal", "--resource", "./missing.txt"]);
  assert.equal(
    missing.stderr,
    `Output file not found: ./missing.txt (local paths resolve from the Workspace root ${root}).\n${nextLine("link-output --help")}\n`,
  );
  await next(missing, /node link-output --help/);
  assert.equal(await adapter.exists("Bad type"), false);
  assert.equal(await adapter.readFile("Peer/Peer.md"), before);
  assert.equal(await adapter.history.currentCommit(), head);
});

test("judge W5 help uses the approved sentences once and removes superseded wording", () => {
  const create = nodeHelpText("create"),
    get = nodeHelpText("get");
  const createText =
    "--id <node-id> sets the new Node's id, so a retry after an unclear result cannot create a duplicate. An existing id or sibling name fails and names the existing Node. Names follow Windows file-name rules on every platform.";
  const getText =
    "A page that holds the complete body returns the full ETag; read:<etag> appears only when the body was truncated and allows continuation and metadata edits only. Read with --full before replacing or confirming content.";
  assert.equal(create.split(createText).length, 2);
  assert.equal(get.split(getText).length, 2);
  assert.doesNotMatch(
    create,
    /--id supplies the Node identity|Name collisions identify|Names must be valid Windows path segments|Inspect an uncertain result before retrying/,
  );
  assert.doesNotMatch(get, /body was truncated\.|For a partial page, read|Incomplete reads expose/);
});

test("real lock timeout gives a runnable inspection command without creating the requested Node", async (t) => {
  const { node, next, adapter } = await fixture(t);
  let acquired!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => (acquired = resolve));
  const held = new Promise<void>((resolve) => (release = resolve));
  const holder = adapter.withLock(MUTATION_LOCK_PATH, async () => {
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
  await next(result, /workspace brief/);
  assert.equal(await adapter.exists("Busy"), false);
});

test("Next is directly executable by the host shell when the workspace contains spaces and an apostrophe", async (t) => {
  const { node } = await fixture(t);
  const failure = await node("get", ["node-missing"]);
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
  assert.match(stdout, /node-goal.*Goal/);
});

test("Card publication order is applied before filtering/pagination with stable equal-time ties and revision checks", async (t) => {
  const { adapter } = await fixture(t);
  await createRoleContext(adapter, { roleId: "role-sort", title: "Sort" });
  for (const cardId of ["card-zold", "card-bnew", "card-anew"])
    await createCardDocument(adapter, { cardId, prompt: cardId, target: "role-sort" });
  const times = new Map([
    ["cards/card-zold.md", "2026-01-01T00:00:00.000Z"],
    ["cards/card-bnew.md", "2026-02-01T00:00:00.000Z"],
    ["cards/card-anew.md", "2026-02-01T00:00:00.000Z"],
  ]);
  t.mock.method(adapter.history, "firstCommitTimes", async () => times);
  const filter = { roleId: "role-sort", state: "pending" as const };
  const listed = await listCardDocuments(adapter, filter);
  assert.deepEqual(
    listed.items.map((item) => item.cardId),
    ["card-anew", "card-bnew", "card-zold"],
  );
  assert.equal((await listCardDocuments(adapter, filter)).revision, listed.revision);
  const first = pageItems(listed, "card.list", { limit: 1 });
  assert.equal(first.items[0]!.cardId, "card-anew");
  const second = pageItems(await listCardDocuments(adapter, filter), "card.list", {
    start: 1,
    limit: 1,
    expectedRevision: listed.revision,
  });
  assert.equal(second.items[0]!.cardId, "card-bnew");
  await createCardDocument(adapter, {
    cardId: "card-latest",
    prompt: "Latest",
    target: "role-sort",
  });
  times.set("cards/card-latest.md", "2026-03-01T00:00:00.000Z");
  const changed = await listCardDocuments(adapter, filter);
  assert.equal(changed.items[0]!.cardId, "card-latest");
  assert.throws(
    () =>
      pageItems(changed, "card.list", { start: 1, limit: 1, expectedRevision: listed.revision }),
    /changed/i,
  );
});
