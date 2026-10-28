import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { openTestService, removeTestFixture } from "./node-fs.js";
import { initializeFixtureWorkspace, testScratchRoot } from "./scratch.js";

type Agents = { path: string; exists: boolean; etag: string | null; text: string };

test("AGENTS.md is read and saved as a plain file, never over a newer version and never into Tent history", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "ui-agents-"));
  t.after(async () => {
    await removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });
  const workspace = path.join(root, "workspace");
  await initializeFixtureWorkspace(workspace);
  const dist = path.join(root, "ui-dist");
  await fs.mkdir(dist);
  const server = await openTestService({ workspaceRoot: workspace, staticDir: dist, port: 0 });
  t.after(() => server.close());
  const token = new URL(server.url).hash.slice("#token=".length);
  const origin = `http://127.0.0.1:${server.port}`;
  const auth = { Authorization: `Bearer ${token}` };
  const get = async <T>(route: string) => {
    const reply = await fetch(origin + route, { headers: auth });
    assert.equal(reply.status, 200, route);
    return (await reply.json()) as T;
  };
  const put = (value: unknown, headers: Record<string, string> = { Origin: origin }) =>
    fetch(origin + "/api/agents", {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json", ...headers },
      body: JSON.stringify(value),
    });
  const file = path.join(workspace, "AGENTS.md");
  const revision = async () => (await get<{ revision: string }>("/api/revision")).revision;
  const before = await revision();

  // Missing: empty, and the first save creates it.
  assert.deepEqual(await get<Agents>("/api/agents"), {
    path: "AGENTS.md",
    exists: false,
    etag: null,
    text: "",
  });
  assert.equal((await fetch(origin + "/api/agents", { headers: {} })).status, 401);
  assert.equal((await put({ baseEtag: null, text: "x" }, {})).status, 403);
  const created = await put({ baseEtag: null, text: "# Rules\n" });
  assert.equal(created.status, 200);
  const first = (await created.json()) as Agents & { changed: boolean };
  assert.equal(first.changed, true);
  assert.equal(first.exists, true);
  assert.equal(await fs.readFile(file, "utf8"), "# Rules\n");
  assert.deepEqual(await get<Agents>("/api/agents"), {
    path: "AGENTS.md",
    exists: true,
    etag: first.etag,
    text: "# Rules\n",
  });

  // Opened while missing, saved after it appeared: refused, with what is there now.
  const late = await put({ baseEtag: null, text: "mine\n" });
  assert.equal(late.status, 409);
  const refused = (await late.json()) as {
    error: { code: string; details: { current: Agents } };
  };
  assert.equal(refused.error.code, "ETAG_CONFLICT");
  assert.equal(refused.error.details.current.etag, first.etag);
  assert.equal(await fs.readFile(file, "utf8"), "# Rules\n");

  // Changed on disk after opening: the page's save is refused and the file is left as it is.
  await fs.writeFile(file, "﻿# Rules\r\n\r\n- one\r\n");
  const stale = await put({ baseEtag: first.etag, text: "# Mine\n" });
  assert.equal(stale.status, 409);
  assert.equal(await fs.readFile(file, "utf8"), "﻿# Rules\r\n\r\n- one\r\n");

  // The page sees \n line ends; the file keeps its BOM and CRLF.
  const edited = await get<Agents>("/api/agents");
  assert.equal(edited.text, "# Rules\n\n- one\n");
  assert.notEqual(edited.etag, first.etag);
  const unchanged = (await (await put({ baseEtag: edited.etag, text: edited.text })).json()) as {
    changed: boolean;
    etag: string;
  };
  assert.deepEqual([unchanged.changed, unchanged.etag], [false, edited.etag]);
  const saved = (await (
    await put({ baseEtag: edited.etag, text: "# Rules\n\n- one\n- two\n" })
  ).json()) as Agents & { changed: boolean };
  assert.equal(saved.changed, true);
  assert.equal(saved.text, "# Rules\n\n- one\n- two\n");
  assert.equal(await fs.readFile(file, "utf8"), "﻿# Rules\r\n\r\n- one\r\n- two\r\n");
  assert.equal((await get<Agents>("/api/agents")).etag, saved.etag);

  // Mixed line ends: saving the text as opened leaves every byte alone.
  const mixed = Buffer.from("﻿# Rules\r\n\r\n- one\n", "utf8");
  await fs.writeFile(file, mixed);
  const opened = await get<Agents>("/api/agents");
  const kept = (await (await put({ baseEtag: opened.etag, text: opened.text })).json()) as {
    changed: boolean;
  };
  assert.equal(kept.changed, false);
  assert.deepEqual(await fs.readFile(file), mixed);

  // A NUL is refused before anything is written: the page could not open the file again.
  const nul = await put({ baseEtag: opened.etag, text: "# Rules\n\u0000hidden\n" });
  assert.equal(nul.status, 415);
  assert.deepEqual(await fs.readFile(file), mixed);
  assert.equal((await get<Agents>("/api/agents")).etag, opened.etag);

  // Git keeps its versions; Tent records nothing.
  assert.equal(await revision(), before);

  await fs.writeFile(file, Buffer.from([0x23, 0x20, 0xff, 0x0a]));
  assert.equal((await fetch(origin + "/api/agents", { headers: auth })).status, 415);
});
