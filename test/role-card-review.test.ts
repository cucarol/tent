import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { createRoleContext } from "../src/core/role-context.js";
import {
  createCardDocument,
  publishCardDocument,
  transitionCardDocument,
} from "../src/core/card-document.js";
import { contentEtag } from "../src/core/etag.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import type { DocumentVersion } from "../src/core/git-history.js";
import { git } from "./helpers.js";

async function fixture(t: TestContext) {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "role-card-review-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, "init");
  const adapter = new NodeFs(root);
  await createRoleContext(adapter, {
    roleId: "role-a",
    title: "Original direction",
    body: "Work here",
  });
  return { root, adapter };
}
const code = (expected: string) => (error: unknown) =>
  (error as { code?: string }).code === expected;

test("RC1: native editor writes during reception checks survive take, replay, interrupt and continue", async (t) => {
  const { root, adapter } = await fixture(t);
  const card = await createCardDocument(adapter, {
    cardId: "card-race",
    prompt: "original request",
    target: "role-a",
  });
  const disk = path.join(root, card.path);
  const initial = await fs.readFile(disk, "utf8");
  const header = adapter.readFrontmatter.bind(adapter),
    changedSince = adapter.history.changedSince.bind(adapter.history);
  let injected = "",
    when: "role" | "history" | undefined;
  const inject = async () => {
    const current = parseFrontmatter(await fs.readFile(disk, "utf8"));
    injected = serializeFrontmatter(current.data, "USER CHANGED REQUEST", current.keyOrder);
    await fs.writeFile(disk, injected, "utf8");
    when = undefined;
  };
  adapter.readFrontmatter = async (p) => {
    const result = await header(p);
    if (when === "role" && p === "roles/role-a.md") await inject();
    return result;
  };
  adapter.history.changedSince = async (version) => {
    const result = await changedSince(version);
    if (when === "history") await inject();
    return result;
  };
  const rejected = async (action: "take" | "interrupt" | "continue", version?: DocumentVersion) => {
    const retainedBefore = (await adapter.history.pathVersions(card.path)).latest;
    await assert.rejects(
      transitionCardDocument(adapter, card.cardId, "role-a", action, version),
      code("STATE_CHANGED"),
    );
    assert.equal(await fs.readFile(disk, "utf8"), injected);
    assert.deepEqual((await adapter.history.pathVersions(card.path)).latest, retainedBefore);
  };
  when = "role";
  await rejected("take");
  await fs.writeFile(disk, initial, "utf8");
  const received = (await transitionCardDocument(
    adapter,
    card.cardId,
    "role-a",
    "take",
  )) as unknown as { version: DocumentVersion };
  const consumed = await fs.readFile(disk, "utf8");
  when = "role";
  await rejected("take");
  await fs.writeFile(disk, consumed, "utf8");
  when = "history";
  await rejected("interrupt", received.version);
  await fs.writeFile(disk, consumed, "utf8");
  const stopped = (await transitionCardDocument(
    adapter,
    card.cardId,
    "role-a",
    "interrupt",
    received.version,
  )) as unknown as { version: DocumentVersion };
  const interrupted = await fs.readFile(disk, "utf8");
  when = "history";
  await rejected("continue", stopped.version);
  await fs.writeFile(disk, interrupted, "utf8");
  const read = adapter.readFile.bind(adapter);
  adapter.readFile = async (p) => {
    if (p === card.path) throw Object.assign(new Error("read failed"), { code: "EIO" });
    return read(p);
  };
  await assert.rejects(
    transitionCardDocument(adapter, card.cardId, "role-a", "continue", stopped.version),
    code("EIO"),
  );
  assert.equal(await fs.readFile(disk, "utf8"), interrupted);
});

test("RC2: external same-stem Markdown remains listed-only for create and handwritten publish", async (t) => {
  const { adapter } = await fixture(t);
  const nodeRaw = "---\nid: node-main\ntype: prompt\n---\nexact selected bytes";
  await adapter.writeFile("Main/Main.md", nodeRaw);
  const sources = [
    { resource: "../../docs/spec.md" },
    { resource: "../../docs/docs.md?mode=1#part", custom: [2, 1] },
    { resource: "../../docs/docs.md?mode=1#part" },
    { resource: "/Main/Main.md" },
    { resource: "/roles/role-a.md" },
  ];
  const readBinary = adapter.readBinary.bind(adapter),
    reads: string[] = [];
  adapter.readBinary = async (p) => {
    reads.push(p);
    assert.ok(!p.startsWith("../"));
    return readBinary(p);
  };
  const created = await createCardDocument(adapter, {
    cardId: "card-addresses",
    prompt: "references",
    sources,
  });
  assert.deepEqual(reads, ["Main/Main.md", "roles/role-a.md"]);
  const saved = parseFrontmatter(await adapter.readFile(created.path)).data.sources as Array<
    Record<string, unknown>
  >;
  assert.deepEqual(saved.slice(0, 3), sources.slice(0, 3));
  assert.equal(await adapter.history.read(saved[3]!.version as DocumentVersion), nodeRaw);
  assert.ok(saved[4]!.version);
  const draft = serializeFrontmatter(
    { type: "card", id: "card-handwritten", schemaVersion: 3, sources, state: "pending" },
    "publish",
  );
  await adapter.writeFile("cards/card-handwritten.md", draft);
  reads.length = 0;
  await publishCardDocument(adapter, "card-handwritten", contentEtag(draft));
  assert.deepEqual(reads, ["cards/card-handwritten.md", "Main/Main.md", "roles/role-a.md"]);
  assert.deepEqual(
    (
      parseFrontmatter(await adapter.readFile("cards/card-handwritten.md")).data
        .sources as unknown[]
    ).slice(0, 3),
    sources.slice(0, 3),
  );
  await assert.rejects(
    createCardDocument(adapter, {
      prompt: "outside",
      sources: [{ resource: "../../../outside/outside.md" }],
    }),
    /outside the Workspace/,
  );
});

test("RC3: deleted Role identities stay unavailable to new creation and old targeted Cards", async (t) => {
  const { root, adapter } = await fixture(t);
  const card = await createCardDocument(adapter, {
    prompt: "Original recipient only",
    target: "role-a",
  });
  await fs.unlink(path.join(root, "roles/role-a.md"));
  await assert.rejects(
    transitionCardDocument(adapter, card.cardId, "role-a", "take"),
    code("ROLE_UNAVAILABLE"),
  );
  await assert.rejects(
    createRoleContext(adapter, { roleId: "role-a", title: "Unrelated new direction", body: "new" }),
    /already exists in history/,
  );
  assert.equal(await adapter.exists("roles/role-a.md"), false);
  const next = await createRoleContext(adapter, { roleId: "role-new", title: "New direction" });
  assert.equal(next.roleId, "role-new");
  await assert.rejects(
    transitionCardDocument(adapter, card.cardId, "role-new", "take"),
    code("RECEPTION_CONFLICT"),
  );
  await assert.rejects(
    transitionCardDocument(adapter, card.cardId, "role-a", "take"),
    code("ROLE_UNAVAILABLE"),
  );
  assert.equal(parseFrontmatter(await adapter.readFile(card.path)).data.state, "pending");
});
