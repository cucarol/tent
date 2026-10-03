import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldTent } from "../src/core/scaffold.js";
import { contentEtag } from "../src/core/etag.js";
import {
  extractOutLinksDetailed as extractOutLinks,
  extractOutLinksDetailed,
} from "../src/markdown/links.js";

async function makeEnv() {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const dir = await fs.mkdtemp(path.join(scratch, "tent-md-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, { name: "md" });
  const env = {
    fs: fsa,
    clock: { now: () => "2026-07-12T00:00:00.000Z" },
    tentName: "md",
    rand: () => 0.42,
  };
  return { dir, env, fsa };
}

test("contentEtag: stable hash slice", () => {
  assert.equal(contentEtag("abc"), contentEtag("abc"));
  assert.notEqual(contentEtag("abc"), contentEtag("abd"));
  assert.equal(contentEtag("x").length, 24);
});

test("extractOutLinks: Markdown and external references", () => {
  const links = extractOutLinks(
    "See [[Alpha]] and [Beta](beta/beta.md) plus https skip [ext](https://x.test)",
  );
  assert.equal(
    links.some((l) => l.raw === "Alpha"),
    false,
  );
  assert.equal(
    links.some((l) => l.kind === "md" && l.raw.includes("beta")),
    true,
  );
  assert.equal(
    links.some((l) => l.kind === "artifact"),
    true,
  );
});

test("NodeFs binary read/write: exact bytes including NUL and non-UTF8", async (t) => {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const dir = await fs.mkdtemp(path.join(scratch, "tent-bin-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const fsa = new NodeFs(dir);
  const bytes = new Uint8Array([0x00, 0xff, 0xfe, 0x01, 0x00, 0x80, 0x7f]);
  await fsa.writeBinary("attachments/node-x/raw.bin", bytes);
  const round = await fsa.readBinary("attachments/node-x/raw.bin");
  assert.deepEqual([...round], [...bytes]);
  // No path escape
  await assert.rejects(() => fsa.writeBinary("../outside.bin", bytes), /escapes Tent root/i);
  await assert.rejects(
    () => fsa.readBinary("..\\..\\windows\\system32\\drivers\\etc\\hosts"),
    /escapes Tent root/i,
  );
});

test("historical attachment names stay separate from Node links", () => {
  const targets = [
    "../attachments/node-x/draft..final.png",
    "../attachments/node-x/my shot.png",
    "../attachments/node-x/file(1).bin",
  ];
  const body =
    targets.map((target) => `![](<${target}>)`).join("\n") + "\nSee [RealConcept](RealConcept)\n";
  assert.deepEqual(
    extractOutLinks(body).map((link) => link.raw),
    ["RealConcept"],
  );
  assert.deepEqual(
    extractOutLinksDetailed(targets.map((target) => `[file](<${target}>)`).join("\n")),
    [],
  );
});
