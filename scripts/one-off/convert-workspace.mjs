#!/usr/bin/env node
// One-off conversion of a Tent workspace written before Node types became exact.
// Not product code: Tent keeps no reader for `goal|prompt|output-<label>`, so the
// working documents AND the independent Git history at <workspace>/.tent/.git are
// converted once.
//
//   node convert-workspace.mjs <workspaceRoot> [--dry-run] [--map <rewrite-map.json>]
//                              [--report <report.json>] [--cli <tent-cli.mjs>]
//
// Conversion of one Node identity document (`<dir>/<name>/<name>.md`, outside the
// operational folders), on every path where it occurs:
//   - the frontmatter is parsed with the `yaml` package using Tent's options;
//   - a type that the former rule accepted (`primary[-label]`, whole value trimmed,
//     label non-empty without surrounding whitespace) becomes the exact `primary`;
//   - the label is appended to `tags` unless an equal tag is present: a flow list
//     gains `, label`, a block list gains `- label` after its last item, a missing
//     or empty `tags` becomes `tags: [label]` right after `type`;
//   - nothing else is touched: other keys, their order, comments, `generated`,
//     `verified` and the body keep their bytes. The result is parsed again and must
//     equal the original data with exactly those two changes, else the document
//     fails.
//
// History: every commit reachable from any ref is rewritten in topological order.
// Each tree is rebuilt with converted identity blobs; Card and Role documents have
// every embedded commit id of this repository replaced by its rewritten id. Author,
// committer, dates, other headers and the whole message (including
// `Tent-Node-Record:` and every other trailer) are kept byte for byte; only `tree`
// and `parent` lines change. Objects are computed in memory, written with
// `git hash-object -w --no-filters`, checked for completeness, and the refs move
// in one `update-ref --stdin` transaction. Derived caches under .git are removed so
// Tent rebuilds them. Working Node documents, Cards, Roles and `temp/` records are
// then converted the same way; because the run starts only from a clean working
// tree, they equal the rewritten HEAD, so no extra capture commit is needed.
//
// Stop Agents, Hooks and `tent ui` first and keep a copy of `.tent`. The run refuses
// to start with uncaptured edits, pending operations or any Node document it cannot
// convert, and exits non-zero listing every such file.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";

export const NODE_TYPES = ["goal", "prompt", "output"];
const OPERATIONAL_TOP = new Set([".git", "roles", "cards", "temp", "attachments", ".tent"]);
const LOCK_GUARD = /^mutation\.lock\.guard(?:\.(?:pending|released|stale)-[^/]+)?$/;
const PENDING_FILES = ["node-move.pending.json", "delete.pending.json"];
const TEXT_EXTENSIONS = new Set([".md", ".json", ".jsonl", ".txt", ".yaml", ".yml"]);
// Same parser settings as src/core/frontmatter.ts.
const YAML_OPTIONS = {
  version: "1.2",
  schema: "core",
  resolveKnownTags: false,
  intAsBigInt: true,
  uniqueKeys: true,
  strict: true,
  logLevel: "silent",
};

// ---------------------------------------------------------------------------
// Paths

/** Mirrors isHistoryDocument/nodeNotePath for Node identity documents. */
export function isNodeIdentityPath(file) {
  const parts = file.split("/");
  if (parts.length < 2) return false;
  if (OPERATIONAL_TOP.has(parts[0]) || LOCK_GUARD.test(parts[0])) return false;
  return parts.at(-1) === `${parts.at(-2)}.md`;
}

/** Card and Role documents pin Git versions of Nodes. */
export function isPinningDocumentPath(file) {
  return /^cards\/card-[^/]+\.md$/.test(file) || /^roles\/role-[^/]+\.md$/.test(file);
}

// ---------------------------------------------------------------------------
// One Node document

function splitFrontmatter(raw) {
  const opening = /^(﻿)?---[\t ]*(\r?\n)/.exec(raw);
  if (!opening) return null;
  const fence = /^---[\t ]*(?:\r?\n|$)/gm;
  fence.lastIndex = opening[0].length;
  const closing = fence.exec(raw);
  if (!closing) return null;
  return { start: opening[0].length, end: closing.index };
}

function readYaml(text) {
  const document = parseDocument(text, YAML_OPTIONS);
  const issue = document.errors[0] ?? document.warnings[0];
  if (issue) throw new Error(issue.message);
  if (document.contents !== null && !isMap(document.contents))
    throw new Error("frontmatter must be a mapping");
  for (const pair of document.contents?.items ?? [])
    if (!isScalar(pair.key) || typeof pair.key.value !== "string")
      throw new Error("mapping keys must be strings");
  return document;
}

function snapshot(document) {
  return {
    data: document.toJS({ maxAliasCount: 100 }) ?? {},
    keys: (document.contents?.items ?? []).map((pair) => String(pair.key.value)),
  };
}

function same(left, right) {
  if (typeof left === "bigint" || typeof right === "bigint") return left === right;
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => same(item, right[index]))
    );
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => Object.prototype.hasOwnProperty.call(right, key) && same(left[key], right[key]),
    )
  );
}

/** Classify a type under the rule Tent used before types became exact. */
export function classifyType(value) {
  if (typeof value !== "string") return { kind: "invalid", reason: "type is not a string" };
  if (NODE_TYPES.includes(value)) return { kind: "exact" };
  const trimmed = value.trim();
  const dash = trimmed.indexOf("-");
  const primary = dash === -1 ? trimmed : trimmed.slice(0, dash);
  if (!NODE_TYPES.includes(primary))
    return {
      kind: "invalid",
      reason: `type ${JSON.stringify(value)} has no goal|prompt|output primary`,
    };
  if (dash === -1) return { kind: "padded", primary };
  const label = trimmed.slice(dash + 1);
  if (!label || label !== label.trim())
    return {
      kind: "invalid",
      reason: `type ${JSON.stringify(value)} has an empty or padded suffix`,
    };
  return { kind: "suffixed", primary, label };
}

function yamlScalar(tag) {
  return /^[\p{L}_][\p{L}\p{N}_-]*$/u.test(tag) &&
    !/^(?:true|false|null|yes|no|on|off|y|n)$/i.test(tag)
    ? tag
    : JSON.stringify(tag);
}

function lineEnd(text, from) {
  const end = text.indexOf("\n", from);
  return end === -1 ? text.length : end + 1;
}

function lineEol(text, end) {
  return text[end - 2] === "\r" ? "\r\n" : "\n";
}

/**
 * Convert one identity document.
 * status: "unchanged" (exact type), "converted" (raw holds the new bytes),
 * "invalid" (not a document the former rule accepted; bytes kept),
 * "failed" (accepted before, but cannot be converted safely; bytes kept).
 */
export function convertNodeDocument(raw) {
  const split = splitFrontmatter(raw);
  if (!split) return { status: "invalid", reason: "no terminated frontmatter" };
  const text = raw.slice(split.start, split.end);
  let document;
  try {
    document = readYaml(text);
  } catch (error) {
    return { status: "invalid", reason: `unparsable frontmatter: ${error.message}` };
  }
  const items = document.contents?.items ?? [];
  const typePair = items.find((pair) => pair.key.value === "type");
  if (!typePair) return { status: "invalid", reason: "missing type" };
  if (!isScalar(typePair.value)) return { status: "invalid", reason: "type is not a scalar" };
  const type = classifyType(typePair.value.value);
  if (type.kind === "exact") return { status: "unchanged", type: typePair.value.value };
  if (type.kind === "invalid") return { status: "invalid", reason: type.reason };
  const from = typePair.value.value;
  const label = type.label;
  const fail = (reason) => ({ status: "failed", from, reason });
  if (label !== undefined && /[/\\\r\n]/.test(label))
    return fail(`suffix ${JSON.stringify(label)} is not a valid tag`);

  const before = snapshot(document);
  const edits = [
    { start: typePair.value.range[0], end: typePair.value.range[1], text: type.primary },
  ];
  const expected = { ...before.data, type: type.primary };
  let expectedKeys = before.keys;
  let tagAdded = false;
  const present =
    label !== undefined &&
    Array.isArray(before.data.tags) &&
    before.data.tags.some((tag) => typeof tag === "string" && tag.trim() === label);
  if (label !== undefined && !present) {
    tagAdded = true;
    const rendered = yamlScalar(label);
    const tagsPair = items.find((pair) => pair.key.value === "tags");
    const value = tagsPair?.value;
    if (!tagsPair) {
      const keyStart = typePair.key.range[0];
      const lineStart = text.lastIndexOf("\n", keyStart - 1) + 1;
      const indent = text.slice(lineStart, keyStart);
      if (!/^[ \t]*$/.test(indent)) return fail("type is not on its own block line");
      const at = lineEnd(text, typePair.value.range[1]);
      const eol = at === text.length && !text.endsWith("\n") ? "\n" : lineEol(text, at);
      edits.push({ start: at, end: at, text: `${indent}tags: [${rendered}]${eol}` });
      expectedKeys = [...before.keys];
      expectedKeys.splice(before.keys.indexOf("type") + 1, 0, "tags");
      expected.tags = [label];
    } else if (!value || (isScalar(value) && value.value === null)) {
      if (value && value.range[0] !== value.range[1])
        edits.push({ start: value.range[0], end: value.range[1], text: `[${rendered}]` });
      else {
        const at = value ? value.range[0] : tagsPair.key.range[1] + 1;
        edits.push({ start: at, end: at, text: ` [${rendered}]` });
      }
      expected.tags = [label];
    } else if (isSeq(value)) {
      if (!value.items.every((item) => isScalar(item)))
        return fail("tags contains a non-scalar item");
      const last = value.items.at(-1);
      if (value.flow) {
        if (last) edits.push({ start: last.range[1], end: last.range[1], text: `, ${rendered}` });
        else edits.push({ start: value.range[0] + 1, end: value.range[0] + 1, text: rendered });
      } else {
        const lineStart = text.lastIndexOf("\n", last.range[0] - 1) + 1;
        const prefix = /^([ \t]*)-[ \t]+$/.exec(text.slice(lineStart, last.range[0]));
        if (!prefix) return fail("block tags list has an unsupported layout");
        const at = lineEnd(text, last.range[1]);
        const eol = at === text.length && !text.endsWith("\n") ? "\n" : lineEol(text, at);
        edits.push({ start: at, end: at, text: `${prefix[1]}- ${rendered}${eol}` });
      }
      expected.tags = [...before.data.tags, label];
    } else return fail("tags is neither a list nor empty");
  }

  let next = text;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
  const converted = raw.slice(0, split.start) + next + raw.slice(split.end);
  let after;
  try {
    after = snapshot(readYaml(next));
  } catch (error) {
    return fail(`edited frontmatter does not parse: ${error.message}`);
  }
  if (!same(after.data, expected) || !same(after.keys, expectedKeys))
    return fail("edited frontmatter differs from the original beyond type and tags");
  if (converted.slice(converted.length - (raw.length - split.end)) !== raw.slice(split.end))
    return fail("body bytes changed");
  return {
    status: "converted",
    raw: converted,
    from,
    to: type.primary,
    tag: label ?? null,
    tagAdded,
    tags: after.data.tags ?? [],
    nodeId: typeof after.data.id === "string" ? after.data.id : null,
  };
}

/** Replace every whole commit id present in `map` with its rewritten id. */
export function remapCommitIds(text, map, hexLength = 40) {
  let count = 0;
  const pattern = new RegExp(`(?<![0-9a-f])[0-9a-f]{${hexLength}}(?![0-9a-f])`, "g");
  const result = text.replace(pattern, (id) => {
    const next = map.get(id);
    if (!next || next === id) return id;
    count++;
    return next;
  });
  return { text: result, count };
}

function mappedIds(text, map, hexLength) {
  const pattern = new RegExp(`(?<![0-9a-f])[0-9a-f]{${hexLength}}(?![0-9a-f])`, "g");
  return [...new Set(text.match(pattern) ?? [])].filter((id) => map.has(id) && map.get(id) !== id);
}

// ---------------------------------------------------------------------------
// Git plumbing

function gitEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  );
}

function git(cwd, args, options = {}) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    input: options.input,
    maxBuffer: 1 << 30,
    windowsHide: true,
    env: gitEnv(),
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFail)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  return options.buffer ? result.stdout : result.stdout.toString("utf8");
}

class ObjectReader {
  constructor(cwd) {
    this.child = spawn("git", ["-C", cwd, "cat-file", "--batch"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: gitEnv(),
    });
    this.chunks = [];
    this.length = 0;
    this.waiters = [];
    this.child.stdout.on("data", (chunk) => {
      this.chunks.push(chunk);
      this.length += chunk.length;
      this.drain();
    });
    this.exited = new Promise((resolve) => this.child.on("close", resolve));
    this.child.on("exit", (code) => {
      for (const waiter of this.waiters.splice(0))
        waiter.reject(new Error(`git cat-file exited ${code}`));
    });
  }
  read(id) {
    return new Promise((resolve, reject) => {
      this.waiters.push({ id, resolve, reject });
      this.child.stdin.write(`${id}\n`);
    });
  }
  drain() {
    let buffer = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    while (this.waiters.length) {
      const newline = buffer.indexOf(10);
      if (newline < 0) break;
      const [id, type, size] = buffer.subarray(0, newline).toString("utf8").split(" ");
      if (type === "missing") {
        buffer = buffer.subarray(newline + 1);
        this.waiters.shift().reject(new Error(`Missing Git object ${id}`));
        continue;
      }
      const end = newline + 1 + Number(size);
      if (buffer.length < end + 1) break;
      const data = Buffer.from(buffer.subarray(newline + 1, end));
      buffer = buffer.subarray(end + 1);
      this.waiters.shift().resolve({ id, type, data });
    }
    this.chunks = buffer.length ? [buffer] : [];
    this.length = buffer.length;
  }
  close() {
    this.child.stdin.end();
    return this.exited;
  }
}

function objectId(format, type, data) {
  return createHash(format)
    .update(Buffer.concat([Buffer.from(`${type} ${data.length}\0`), data]))
    .digest("hex");
}

function parseTree(data, hashBytes) {
  const entries = [];
  for (let offset = 0; offset < data.length;) {
    const space = data.indexOf(32, offset);
    const nul = data.indexOf(0, space);
    entries.push({
      mode: data.subarray(offset, space),
      name: data.subarray(space + 1, nul),
      id: data.subarray(nul + 1, nul + 1 + hashBytes).toString("hex"),
    });
    offset = nul + 1 + hashBytes;
  }
  return entries;
}

function serializeTree(entries) {
  return Buffer.concat(
    entries.flatMap((entry) => [
      entry.mode,
      Buffer.from(" "),
      entry.name,
      Buffer.from([0]),
      Buffer.from(entry.id, "hex"),
    ]),
  );
}

/**
 * Plan the rewrite of every commit reachable from a ref, in memory.
 * Returns the new objects, the commit map, ref updates and statistics.
 */
export async function planHistoryRewrite(tentRoot) {
  const format =
    git(tentRoot, ["rev-parse", "--show-object-format"]).trim() === "sha256" ? "sha256" : "sha1";
  const hexLength = format === "sha256" ? 64 : 40;
  const hashBytes = hexLength / 2;
  const refs = git(tentRoot, ["for-each-ref", "--format=%(objectname) %(objecttype) %(refname)"])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, type, name] = line.split(" ");
      if (type !== "commit")
        throw new Error(`Unsupported ${type} ref ${name}; only commit refs are rewritten`);
      return { id, name };
    });
  const symbolic = git(tentRoot, ["symbolic-ref", "-q", "HEAD"], { allowFail: true }).trim();
  const head = git(tentRoot, ["rev-parse", "--verify", "-q", "HEAD"], { allowFail: true }).trim();
  if (!symbolic && head) refs.push({ id: head, name: "HEAD", detached: true });
  const commits = git(tentRoot, ["rev-list", "--topo-order", "--reverse", "--all"])
    .split("\n")
    .filter(Boolean);
  const allCommits = new Set(commits);
  const reader = new ObjectReader(tentRoot);
  const map = new Map();
  const objects = new Map(); // id -> { type, data }
  const trees = new Map();
  const blobs = new Map();
  const stats = {
    objectFormat: format,
    commits: commits.length,
    commitsRewritten: 0,
    nodeBlobsSeen: 0,
    nodeBlobsConverted: 0,
    nodeBlobsUnchanged: 0,
    nodeBlobsInvalidKept: 0,
    pinningBlobsRemapped: 0,
    commitIdsReplaced: 0,
    conversions: {},
    invalidKept: [],
    failed: [],
    unmappedReferences: [],
    otherBlobsWithCommitIds: [],
  };
  const addObject = (type, data) => {
    const id = objectId(format, type, data);
    if (!objects.has(id)) objects.set(id, { type, data });
    return id;
  };

  async function rewriteBlob(id, file, commit) {
    const identity = isNodeIdentityPath(file);
    const pinning = isPinningDocumentPath(file);
    const key = `${id}\0${identity ? "node" : pinning ? "pin" : "other"}`;
    if (blobs.has(key)) return blobs.get(key);
    let result = id;
    const extension = path.extname(file).toLowerCase();
    if (identity || pinning || TEXT_EXTENSIONS.has(extension)) {
      const raw = (await reader.read(id)).data;
      const text = raw.toString("utf8");
      const lossless = Buffer.from(text, "utf8").equals(raw);
      if (identity) {
        stats.nodeBlobsSeen++;
        const converted = lossless
          ? convertNodeDocument(text)
          : { status: "invalid", reason: "not UTF-8" };
        if (converted.status === "converted") {
          stats.nodeBlobsConverted++;
          const label = `${converted.from} -> ${converted.to}${converted.tag ? ` + ${converted.tag}` : ""}`;
          stats.conversions[label] = (stats.conversions[label] ?? 0) + 1;
          result = addObject("blob", Buffer.from(converted.raw, "utf8"));
        } else if (converted.status === "unchanged") stats.nodeBlobsUnchanged++;
        else if (converted.status === "invalid") {
          stats.nodeBlobsInvalidKept++;
          stats.invalidKept.push({ commit, path: file, blob: id, reason: converted.reason });
        } else
          stats.failed.push({
            commit,
            path: file,
            blob: id,
            from: converted.from,
            reason: converted.reason,
          });
        const embedded = mappedIds(text, map, hexLength);
        if (embedded.length)
          stats.otherBlobsWithCommitIds.push({ commit, path: file, ids: embedded });
      } else if (lossless) {
        if (pinning) {
          const pattern = new RegExp(`(?<![0-9a-f])[0-9a-f]{${hexLength}}(?![0-9a-f])`, "g");
          const unmapped = [...new Set(text.match(pattern) ?? [])].filter(
            (ref) => allCommits.has(ref) && !map.has(ref),
          );
          if (unmapped.length) stats.unmappedReferences.push({ commit, path: file, ids: unmapped });
          const remapped = remapCommitIds(text, map, hexLength);
          if (remapped.count) {
            stats.pinningBlobsRemapped++;
            stats.commitIdsReplaced += remapped.count;
            result = addObject("blob", Buffer.from(remapped.text, "utf8"));
          }
        } else {
          const embedded = mappedIds(text, map, hexLength);
          if (embedded.length)
            stats.otherBlobsWithCommitIds.push({ commit, path: file, ids: embedded });
        }
      }
    }
    blobs.set(key, result);
    return result;
  }

  async function rewriteTree(id, dir, commit) {
    const parts = dir ? dir.split("/") : [];
    const zone =
      parts.length === 0
        ? "root"
        : OPERATIONAL_TOP.has(parts[0]) || LOCK_GUARD.test(parts[0])
          ? parts[0]
          : "node";
    const key = `${id}\0${zone}\0${parts.length ? parts.at(-1) : ""}\0${parts.length === 1 ? "top" : ""}`;
    if (trees.has(key)) return trees.get(key);
    const { data } = await reader.read(id);
    const entries = parseTree(data, hashBytes);
    let changed = false;
    for (const entry of entries) {
      const name = entry.name.toString("utf8");
      const file = dir ? `${dir}/${name}` : name;
      const mode = entry.mode.toString("ascii");
      let next = entry.id;
      if (mode === "40000") next = await rewriteTree(entry.id, file, commit);
      else if (mode === "100644" || mode === "100755")
        next = await rewriteBlob(entry.id, file, commit);
      if (next !== entry.id) {
        entry.id = next;
        changed = true;
      }
    }
    const result = changed ? addObject("tree", serializeTree(entries)) : id;
    trees.set(key, result);
    return result;
  }

  try {
    for (const commit of commits) {
      const { data } = await reader.read(commit);
      // Header lines stay bytes: only `tree` and `parent` lines change.
      const end = data.indexOf("\n\n");
      const headerEnd = end === -1 ? data.length : end;
      const next = [];
      for (let start = 0; start < headerEnd;) {
        const stop = data.indexOf(10, start);
        const lineStop = stop === -1 || stop > headerEnd ? headerEnd : stop;
        const line = data.subarray(start, lineStop);
        const text = line.toString("latin1");
        start = lineStop + 1;
        if (/^(gpgsig|gpgsig-sha256|mergetag) /.test(text))
          throw new Error(
            `Commit ${commit} is signed or carries a merge tag; rewriting would invalidate it`,
          );
        if (text.startsWith("tree "))
          next.push(Buffer.from(`tree ${await rewriteTree(text.slice(5), "", commit)}`));
        else if (text.startsWith("parent ")) {
          const parent = map.get(text.slice(7));
          if (!parent)
            throw new Error(`Parent ${text.slice(7)} of ${commit} was not rewritten first`);
          next.push(Buffer.from(`parent ${parent}`));
        } else next.push(line);
      }
      const rewritten = Buffer.concat([
        ...next.flatMap((line, index) => (index ? [Buffer.from("\n"), line] : [line])),
        data.subarray(headerEnd),
      ]);
      const id = rewritten.equals(data) ? commit : addObject("commit", rewritten);
      if (id !== commit) stats.commitsRewritten++;
      map.set(commit, id);
    }
  } finally {
    await reader.close();
  }
  const updates = refs.map((ref) => ({ ...ref, next: map.get(ref.id) ?? ref.id }));
  return {
    format,
    hexLength,
    map,
    objects,
    updates,
    stats,
    oldHead: head || null,
    newHead: head ? map.get(head) : null,
  };
}

/** Write the planned objects and move the refs; nothing is written on failure. */
export function applyHistoryRewrite(tentRoot, plan) {
  const scratch = fs.mkdtempSync(path.join(tentRoot, ".git", "tent-type-tags-objects-"));
  try {
    for (const type of ["blob", "tree", "commit"]) {
      const list = [...plan.objects].filter(([, object]) => object.type === type);
      if (!list.length) continue;
      const files = list.map(([id, object], index) => {
        const file = path.join(scratch, `${type}-${index}`);
        fs.writeFileSync(file, object.data);
        return { id, file };
      });
      const written = git(
        tentRoot,
        ["hash-object", "-w", "--no-filters", "-t", type, "--stdin-paths"],
        {
          input: files.map((entry) => entry.file).join("\n") + "\n",
        },
      )
        .split("\n")
        .filter(Boolean);
      files.forEach((entry, index) => {
        if (written[index] !== entry.id)
          throw new Error(`Git stored ${type} ${written[index]} for computed ${entry.id}`);
      });
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const tips = [...new Set(plan.updates.map((update) => update.next))];
  if (tips.length) {
    const missing = git(tentRoot, ["rev-list", "--objects", "--missing=print", ...tips])
      .split("\n")
      .filter((line) => line.startsWith("?"));
    if (missing.length)
      throw new Error(`Rewritten history is incomplete: ${missing.slice(0, 5).join(", ")}`);
  }
  const commands = plan.updates
    .filter((update) => update.next !== update.id)
    .map((update) => `update ${update.name} ${update.next} ${update.id}\n`)
    .join("");
  if (commands)
    git(
      tentRoot,
      ["update-ref", "--no-deref", "-m", "tent: convert type suffixes to tags", "--stdin"],
      {
        input: commands,
      },
    );
}

/** Message, author and committer of every commit, in order, without ids. */
function historyFingerprint(tentRoot, head) {
  if (!head) return "";
  return createHash("sha256")
    .update(
      git(
        tentRoot,
        [
          "log",
          "--topo-order",
          "--date=raw",
          "--format=%an%x00%ae%x00%ad%x00%cn%x00%ce%x00%cd%x00%B%x01",
          head,
        ],
        {
          buffer: true,
        },
      ),
    )
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Working files

function walkFiles(tentRoot) {
  const files = [];
  const visit = (dir, relative) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!relative && entry.name === ".git") continue;
      const child = path.join(dir, entry.name);
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(child, file);
      else if (entry.isFile()) files.push(file);
    }
  };
  visit(tentRoot, "");
  return files.sort();
}

function uncapturedChanges(tentRoot) {
  return git(tentRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    buffer: true,
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function planWorkingFiles(tentRoot) {
  const result = { nodes: [], failed: [], unchanged: 0, writes: [] };
  for (const file of walkFiles(tentRoot)) {
    if (!isNodeIdentityPath(file)) continue;
    const raw = fs.readFileSync(path.join(tentRoot, file));
    const text = raw.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(raw)) {
      result.failed.push({ path: file, reason: "not UTF-8" });
      continue;
    }
    const converted = convertNodeDocument(text);
    if (converted.status === "unchanged") result.unchanged++;
    else if (converted.status === "converted") {
      result.nodes.push({
        path: file,
        from: converted.from,
        to: converted.to,
        tag: converted.tag,
        tagAdded: converted.tagAdded,
        tags: converted.tags,
        nodeId: converted.nodeId,
      });
      result.writes.push({ path: file, raw: converted.raw });
    } else
      result.failed.push({
        path: file,
        status: converted.status,
        reason: converted.reason,
        from: converted.from,
      });
  }
  return result;
}

function remapWorkingFiles(tentRoot, map, hexLength, write) {
  const remapped = [];
  const reported = [];
  for (const file of walkFiles(tentRoot)) {
    const top = file.split("/")[0];
    if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    const absolute = path.join(tentRoot, file);
    const raw = fs.readFileSync(absolute);
    const text = raw.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(raw)) continue;
    if (isPinningDocumentPath(file) || top === "temp") {
      const next = remapCommitIds(text, map, hexLength);
      if (next.count) {
        remapped.push({ path: file, ids: next.count });
        if (write) fs.writeFileSync(absolute, next.text);
      }
    } else {
      const ids = mappedIds(text, map, hexLength);
      if (ids.length) reported.push({ path: file, ids });
    }
  }
  return { remapped, reported };
}

function removeDerivedCaches(tentRoot) {
  const gitDir = path.join(tentRoot, ".git");
  const removed = [];
  for (const entry of fs.readdirSync(gitDir)) {
    if (
      /^tent-derived-.*\.json$/.test(entry) ||
      entry === "tent-history-index.json" ||
      /^tent-.*cache/.test(entry) ||
      /^tent-.*\.tmp$/.test(entry)
    ) {
      fs.rmSync(path.join(gitDir, entry), { recursive: true, force: true });
      removed.push(entry);
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Whole workspace

export async function convertWorkspace(workspaceRoot, options = {}) {
  const started = Date.now();
  const tentRoot = path.join(path.resolve(workspaceRoot), ".tent");
  const report = {
    workspace: path.resolve(workspaceRoot),
    dryRun: !!options.dryRun,
    ok: false,
    problems: [],
  };
  if (!fs.existsSync(path.join(tentRoot, ".git"))) {
    report.problems.push(`${tentRoot} has no independent Git history (.git)`);
    return report;
  }
  for (const file of PENDING_FILES)
    if (fs.existsSync(path.join(tentRoot, file)))
      report.problems.push(`pending operation ${file}; finish or recover it first`);
  const dirty = uncapturedChanges(tentRoot);
  if (dirty.length)
    report.problems.push(`uncaptured changes (let Tent capture them first): ${dirty.join(", ")}`);
  const working = planWorkingFiles(tentRoot);
  report.working = {
    nodeDocuments: working.unchanged + working.nodes.length + working.failed.length,
    converted: working.nodes.length,
    unchanged: working.unchanged,
    failed: working.failed,
    conversions: working.nodes,
  };
  if (working.failed.length)
    report.problems.push(
      `${working.failed.length} Node document(s) cannot be converted: ${working.failed.map((item) => item.path).join(", ")}`,
    );
  if (report.problems.length) return report;

  const historyStarted = Date.now();
  const plan = await planHistoryRewrite(tentRoot);
  report.history = {
    ...plan.stats,
    objectsWritten: plan.objects.size,
    blobsWritten: [...plan.objects.values()].filter((object) => object.type === "blob").length,
    treesWritten: [...plan.objects.values()].filter((object) => object.type === "tree").length,
    commitsWritten: [...plan.objects.values()].filter((object) => object.type === "commit").length,
    oldHead: plan.oldHead,
    newHead: plan.newHead,
    refs: plan.updates.map((update) => ({ ref: update.name, from: update.id, to: update.next })),
  };
  if (plan.stats.failed.length)
    report.problems.push(
      `${plan.stats.failed.length} historical Node version(s) accepted by the former rule cannot be converted`,
    );
  if (plan.stats.unmappedReferences.length)
    report.problems.push(
      `${plan.stats.unmappedReferences.length} document version(s) reference commits not rewritten before them`,
    );
  if (report.problems.length) return report;
  const beforeFingerprint = historyFingerprint(tentRoot, plan.oldHead);
  if (!options.dryRun) {
    applyHistoryRewrite(tentRoot, plan);
    const afterFingerprint = historyFingerprint(tentRoot, plan.newHead);
    report.history.messagesAndAuthorsUnchanged = beforeFingerprint === afterFingerprint;
    if (!report.history.messagesAndAuthorsUnchanged)
      report.problems.push("commit messages, authors or dates differ after the rewrite");
    if (plan.newHead) git(tentRoot, ["read-tree", plan.newHead]);
    report.history.cachesRemoved = removeDerivedCaches(tentRoot);
  }
  report.history.seconds = (Date.now() - historyStarted) / 1000;
  if (options.mapFile) {
    fs.mkdirSync(path.dirname(path.resolve(options.mapFile)), { recursive: true });
    fs.writeFileSync(options.mapFile, JSON.stringify(Object.fromEntries(plan.map), null, 2) + "\n");
    report.history.mapFile = path.resolve(options.mapFile);
  }

  if (!options.dryRun)
    for (const write of working.writes)
      fs.writeFileSync(path.join(tentRoot, write.path), write.raw);
  const pinned = remapWorkingFiles(tentRoot, plan.map, plan.hexLength, !options.dryRun);
  report.working.remapped = pinned.remapped;
  report.working.otherFilesWithRewrittenCommitIds = pinned.reported;
  if (!options.dryRun) {
    git(tentRoot, ["update-index", "-q", "--refresh"], { allowFail: true });
    const remaining = uncapturedChanges(tentRoot);
    report.working.captureCommitNeeded = remaining.length > 0;
    if (remaining.length)
      report.problems.push(`working files differ from the rewritten HEAD: ${remaining.join(", ")}`);
    if (options.cli)
      verifyWithCli(tentRoot, workspaceRoot, options.cli, working.nodes, plan.newHead, report);
  }
  report.seconds = (Date.now() - started) / 1000;
  report.ok = report.problems.length === 0;
  return report;
}

/**
 * Ask the new CLI for every converted Node through `node list --type <t>` over the
 * whole Workspace; each must be listed with its converted type and tags, and the
 * reads must not capture anything.
 */
function verifyWithCli(tentRoot, workspaceRoot, cli, nodes, head, report) {
  const items = new Map();
  for (const type of ["goal", "prompt", "output"])
    for (let cursor; ;) {
      const result = spawnSync(
        process.execPath,
        [
          path.resolve(cli),
          "node",
          "list",
          "--type",
          type,
          "--include-archived",
          "--limit",
          "100",
          ...(cursor ? ["--cursor", cursor] : []),
          "--json",
          "--workspace",
          path.resolve(workspaceRoot),
        ],
        { encoding: "utf8", maxBuffer: 1 << 30, windowsHide: true },
      );
      if (result.status !== 0) {
        report.problems.push(`${cli} node list --type ${type} failed: ${result.stderr.trim()}`);
        return;
      }
      const page = JSON.parse(result.stdout);
      for (const item of page.items) items.set(item.nodeId, item);
      if (!page.page?.hasMore) break;
      cursor = page.page.nextCursor;
    }
  const mismatched = [];
  for (const node of nodes) {
    const item = items.get(node.nodeId);
    const tags = [...new Set(node.tags.map((tag) => String(tag).trim()).filter(Boolean))].sort();
    const listedTags = [...(item?.tags ?? [])].sort();
    if (!item || item.type !== node.to || JSON.stringify(listedTags) !== JSON.stringify(tags))
      mismatched.push({
        path: node.path,
        nodeId: node.nodeId,
        expected: { type: node.to, tags },
        listed: item ? { type: item.type, tags: listedTags } : null,
      });
  }
  report.cli = {
    cli: path.resolve(cli),
    listed: items.size,
    verified: nodes.length - mismatched.length,
    mismatched,
  };
  if (mismatched.length)
    report.problems.push(`${mismatched.length} converted Node(s) read differently through ${cli}`);
  const after = git(tentRoot, ["rev-parse", "HEAD"]).trim();
  if (head && after !== head)
    report.problems.push(`reading through ${cli} captured a new commit ${after}`);
}

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--map") args.mapFile = argv[++i];
    else if (arg === "--report") args.reportFile = argv[++i];
    else if (arg === "--cli") args.cli = argv[++i];
    else if (!args.root && !arg.startsWith("--")) args.root = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.root)
    throw new Error(
      "Usage: convert-workspace.mjs <workspaceRoot> [--dry-run] [--map <file>] [--report <file>] [--cli <tent-cli.mjs>]",
    );
  return args;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  const report = await convertWorkspace(args.root, args);
  if (args.reportFile) fs.writeFileSync(args.reportFile, JSON.stringify(report, null, 2) + "\n");
  const history = report.history ?? {};
  console.log(JSON.stringify(report, null, 2));
  console.error(
    [
      `${report.dryRun ? "dry run" : "converted"}: ${report.ok ? "ok" : "FAILED"}`,
      `working Node documents: converted ${report.working?.converted ?? 0}, unchanged ${report.working?.unchanged ?? 0}, failed ${report.working?.failed?.length ?? 0}`,
      `history: commits ${history.commits ?? 0}, rewritten ${history.commitsRewritten ?? 0}, Node blobs converted ${history.nodeBlobsConverted ?? 0}, Card/Role blobs remapped ${history.pinningBlobsRemapped ?? 0}, invalid versions kept ${history.nodeBlobsInvalidKept ?? 0}, ${history.seconds ?? 0} s`,
      ...report.problems.map((problem) => `problem: ${problem}`),
    ].join("\n"),
  );
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await main();
