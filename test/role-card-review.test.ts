import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { createRoleContext } from "../src/core/role-context.js";
import { createCardDocument, takeCardDocument } from "../src/core/card-document.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import type { DocumentVersion } from "../src/core/git-history.js";
import { git } from "./helpers.js";

async function fixture(t: TestContext) {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "role-card-review-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
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

test("RC1: native editor writes during first reception and replay survive rejected takes", async (t) => {
  const { root, adapter } = await fixture(t);
  const card = await createCardDocument(adapter, {
    cardId: "card-race",
    prompt: "original request",
    target: "role-a",
  });
  const disk = path.join(root, card.path);
  const initial = await fs.readFile(disk, "utf8");
  const header = adapter.readFrontmatter.bind(adapter);
  let injected = "",
    when: "role" | undefined;
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
  const rejected = async () => {
    const retainedBefore = (await adapter.history.pathVersions(card.path)).latest;
    await assert.rejects(takeCardDocument(adapter, card.cardId, "role-a"), code("STATE_CHANGED"));
    assert.equal(await fs.readFile(disk, "utf8"), injected);
    assert.deepEqual((await adapter.history.pathVersions(card.path)).latest, retainedBefore);
  };
  when = "role";
  await rejected();
  await fs.writeFile(disk, initial, "utf8");
  await takeCardDocument(adapter, card.cardId, "role-a");
  const consumed = await fs.readFile(disk, "utf8");
  when = "role";
  await rejected();
  await fs.writeFile(disk, consumed, "utf8");
  const read = adapter.readFile.bind(adapter);
  adapter.readFile = async (p) => {
    if (p === card.path) throw Object.assign(new Error("read failed"), { code: "EIO" });
    return read(p);
  };
  await assert.rejects(takeCardDocument(adapter, card.cardId, "role-a"), code("EIO"));
  assert.equal(await fs.readFile(disk, "utf8"), consumed);
});

test("RC2: external same-stem Markdown remains listed-only at publication", async (t) => {
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
  await assert.rejects(takeCardDocument(adapter, card.cardId, "role-a"), code("ROLE_UNAVAILABLE"));
  await assert.rejects(
    createRoleContext(adapter, { roleId: "role-a", title: "Unrelated new direction", body: "new" }),
    /already exists in history/,
  );
  assert.equal(await adapter.exists("roles/role-a.md"), false);
  const next = await createRoleContext(adapter, { roleId: "role-new", title: "New direction" });
  assert.equal(next.roleId, "role-new");
  await assert.rejects(
    takeCardDocument(adapter, card.cardId, "role-new"),
    code("RECEPTION_CONFLICT"),
  );
  await assert.rejects(takeCardDocument(adapter, card.cardId, "role-a"), code("ROLE_UNAVAILABLE"));
  assert.equal(parseFrontmatter(await adapter.readFile(card.path)).data.state, "pending");
});
