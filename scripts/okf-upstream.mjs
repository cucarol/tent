#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = "GoogleCloudPlatform/knowledge-catalog";
const FILE = "okf/SPEC.md";
const BRANCH = "main";
export const SOURCE = `https://github.com/${REPO}/blob/${BRANCH}/${FILE}`;
export const PINNED = path.resolve(import.meta.dirname, "../docs/upstream/okf-SPEC.md");
const HEADER = /^<!--\r?\n([\s\S]*?)\r?\n-->\r?\n/;
const SHOWN_CHANGES = 6;

class FetchFailure extends Error {}

const normalize = (text) => text.replace(/\r\n?/g, "\n");
const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const shortSha = (sha) => (sha ? sha.slice(0, 12) : "unknown");

// 固定副本 = 头部注释 + 上游原文；比较只看正文，行尾统一为 LF。
export function parsePinned(text) {
  const match = HEADER.exec(text);
  if (!match) throw new Error("pinned copy has no header comment");
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([a-z0-9-]+): (.+)$/.exec(line);
    if (field) fields[field[1]] = field[2];
  }
  return { fields, body: normalize(text.slice(match[0].length)) };
}

export function renderPinned({ commit, date, fetchedAt, body }) {
  const version = /^\*\*Version (\d+(?:\.\d+)*)\*\*$/m.exec(body)?.[1];
  if (!version) throw new Error("upstream SPEC.md has no **Version x.y** line");
  const header = [
    "<!--",
    "Pinned copy of the upstream Open Knowledge Format specification. Everything after this",
    "comment is the upstream file, unmodified. Do not edit; refresh with",
    "`npm run okf:upstream -- --update`.",
    `source: ${SOURCE}`,
    `upstream-commit: ${commit}`,
    `upstream-date: ${date}`,
    `fetched-at: ${fetchedAt}`,
    "license: Apache-2.0 (docs/upstream/okf-LICENSE.md, THIRD_PARTY_NOTICES.md)",
    `okf-version: ${version}`,
    `sha256: ${sha256(body)}`,
    `bytes: ${Buffer.byteLength(body)}`,
    "-->",
    "",
  ];
  return header.join("\n") + body;
}

// 行级差异：先去掉公共首尾，再对中段做 LCS；连续删改合成一块，块内成对的算 changed。
export function diffLines(before, after) {
  const a = before.split("\n"),
    b = after.split("\n");
  let start = 0,
    endA = a.length,
    endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const x = a.slice(start, endA),
    y = b.slice(start, endB);
  const ops = [];
  if (x.length * y.length > 4_000_000) {
    x.forEach((line, i) => ops.push({ op: "-", line: start + i + 1, text: line }));
    y.forEach((line, j) => ops.push({ op: "+", line: start + j + 1, text: line }));
  } else {
    const w = y.length + 1;
    const lcs = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--)
      for (let j = y.length - 1; j >= 0; j--)
        lcs[i * w + j] =
          x[i] === y[j]
            ? lcs[(i + 1) * w + j + 1] + 1
            : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    let i = 0,
      j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) {
        ops.push({ op: "=" });
        i++;
        j++;
      } else if (i < x.length && (j === y.length || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) {
        ops.push({ op: "-", line: start + i + 1, text: x[i++] });
      } else {
        ops.push({ op: "+", line: start + j + 1, text: y[j++] });
      }
    }
  }
  let changed = 0,
    added = 0,
    removed = 0,
    deletes = 0,
    inserts = 0;
  const flush = () => {
    const paired = Math.min(deletes, inserts);
    changed += paired;
    removed += deletes - paired;
    added += inserts - paired;
    deletes = inserts = 0;
  };
  for (const { op } of ops) {
    if (op === "-") deletes++;
    else if (op === "+") inserts++;
    else flush();
  }
  flush();
  return { changed, added, removed, lines: ops.filter(({ op }) => op !== "=") };
}

async function request(url, { api = false } = {}) {
  const headers = { "user-agent": "tent-okf-upstream" };
  if (api) {
    headers.accept = "application/vnd.github+json";
    if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  let response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new FetchFailure(`${url}: ${error.cause?.message ?? error.message}`);
  }
  if (!response.ok) throw new FetchFailure(`${url}: HTTP ${response.status}`);
  return api ? response.json() : response.text();
}

// 先取最后一次改动该文件的提交，再按该 sha 取原文，保证 sha、日期与正文一致。
export async function fetchUpstream() {
  const commits = await request(
    `https://api.github.com/repos/${REPO}/commits?path=${FILE}&sha=${BRANCH}&per_page=1`,
    { api: true },
  );
  const commit = commits?.[0]?.sha;
  const date = commits?.[0]?.commit?.committer?.date;
  if (!commit || !date) throw new FetchFailure(`no commit found for ${FILE} on ${BRANCH}`);
  const body = normalize(
    await request(`https://raw.githubusercontent.com/${REPO}/${commit}/${FILE}`),
  );
  return { commit, date, body };
}

function printDiff(diff) {
  console.log(
    `  lines: ${diff.changed} changed, ${diff.added} added, ${diff.removed} removed (pinned -> upstream)`,
  );
  for (const { op, line, text } of diff.lines.slice(0, SHOWN_CHANGES)) {
    const shown = text.length > 100 ? `${text.slice(0, 100)}...` : text;
    console.log(`    ${op} L${line}: ${shown}`);
  }
  if (diff.lines.length > SHOWN_CHANGES)
    console.log(`    ... ${diff.lines.length - SHOWN_CHANGES} more changed line(s)`);
}

async function main(args) {
  if (args.some((arg) => arg !== "--update") || args.length > 1) {
    console.error("usage: node scripts/okf-upstream.mjs [--update]");
    return 2;
  }
  const update = args.length === 1;
  let pinned;
  try {
    pinned = parsePinned(fs.readFileSync(PINNED, "utf8"));
  } catch (error) {
    if (!update) {
      console.error(`OKF upstream: cannot read pinned copy ${PINNED}: ${error.message}`);
      return 2;
    }
  }
  let upstream;
  try {
    upstream = await fetchUpstream();
  } catch (error) {
    if (!(error instanceof FetchFailure)) throw error;
    console.error(`OKF upstream: FETCH FAILED, no drift verdict: ${error.message}`);
    return 1;
  }
  const upstreamLabel = `${shortSha(upstream.commit)} (${upstream.date})`;
  const pinnedLabel = pinned
    ? `${shortSha(pinned.fields["upstream-commit"])} (${pinned.fields["upstream-date"] ?? "unknown"})`
    : "missing";
  const identical = pinned?.body === upstream.body;

  if (update) {
    if (identical && pinned.fields["upstream-commit"] === upstream.commit) {
      console.log(`OKF upstream: pinned copy already matches ${upstreamLabel}; not rewritten.`);
      return 0;
    }
    const fetchedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    fs.mkdirSync(path.dirname(PINNED), { recursive: true });
    fs.writeFileSync(PINNED, renderPinned({ ...upstream, fetchedAt }));
    const written = parsePinned(fs.readFileSync(PINNED, "utf8")).fields;
    console.log(
      `OKF upstream: pinned copy updated to ${upstreamLabel}, OKF ${written["okf-version"]}, ${written.bytes} bytes, sha256 ${written.sha256}.`,
    );
    if (pinned && !identical) {
      console.log(`  previous: ${pinnedLabel}`);
      printDiff(diffLines(pinned.body, upstream.body));
    }
    if (!identical) console.log("Re-check every OKF § reference: npm run test:fast.");
    return 0;
  }

  if (identical) {
    console.log(
      `OKF upstream: pinned copy matches upstream ${BRANCH} ${upstreamLabel}, ${Buffer.byteLength(upstream.body)} bytes.`,
    );
    if (pinned.fields["upstream-commit"] !== upstream.commit)
      console.log(`  note: header records ${pinnedLabel}; --update refreshes it.`);
    return 0;
  }
  console.log(`OKF upstream: DRIFT, pinned copy differs from upstream ${BRANCH}.`);
  console.log(`  pinned:   ${pinnedLabel}`);
  console.log(`  upstream: ${upstreamLabel}`);
  printDiff(diffLines(pinned.body, upstream.body));
  console.log(
    "Refresh with `npm run okf:upstream -- --update`, then re-check every OKF § reference.",
  );
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error) => {
      console.error(`OKF upstream: ${error.message}`);
      process.exitCode = 2;
    },
  );
}
