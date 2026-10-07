#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseDocument, isMap } from "yaml";
import { fromMarkdown } from "mdast-util-from-markdown";

const PINNED_SPEC = path.resolve(import.meta.dirname, "../docs/upstream/okf-SPEC.md");
const RUNTIME_DIRS = new Set([".git", "temp", "attachments"]);

// 门禁离线对照固定的上游副本：版本与来源取自其头部注释，由 npm run okf:upstream 维护。
export function pinnedOkfSpec(file = PINNED_SPEC) {
  const header = /^<!--\r?\n([\s\S]*?)\r?\n-->/.exec(fs.readFileSync(file, "utf8"))?.[1] ?? "";
  const field = (name) => new RegExp(`^${name}: (\\S+)\\r?$`, "m").exec(header)?.[1];
  const version = field("okf-version"),
    source = field("source");
  if (!version || !source)
    throw new Error(`Pinned OKF spec header lacks okf-version or source: ${file}`);
  return { version, source };
}

// OKF 结构合规与 Tent 链接完整性独立报告；断链不使 OKF 文档失去合规性。
export function validateBundle(bundle, { workspace = false } = {}) {
  const root = path.resolve(bundle);
  const pinned = pinnedOkfSpec();
  if (!fs.statSync(root).isDirectory()) throw new Error(`Not a bundle directory: ${root}`);
  const errors = [],
    links = [],
    files = [];
  const reportError = (file, rule, message) => errors.push({ file, rule, message });
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (workspace && directory === root && RUNTIME_DIRS.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
    }
  };
  walk(root);
  for (const full of files.sort()) {
    const file = path.relative(root, full).replaceAll(path.sep, "/");
    const basename = path.basename(file);
    let body;
    try {
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(full));
      const opening = /^---[\t ]*\r?\n/.exec(raw);
      let metadata;
      body = raw;
      if (opening) {
        const closing = /^---[\t ]*(?:\r?\n|$)/gm;
        closing.lastIndex = opening[0].length;
        const end = closing.exec(raw);
        if (!end) throw new Error("Unterminated YAML frontmatter");
        const document = parseDocument(raw.slice(opening[0].length, end.index));
        if (document.errors.length) throw new Error(document.errors[0].message);
        if (!isMap(document.contents)) throw new Error("Frontmatter must be a YAML mapping");
        metadata = document.toJS({ maxAliasCount: 100 });
        body = raw.slice(end.index + end[0].length);
      }
      if (basename === "index.md") {
        if (
          metadata &&
          (file !== "index.md" || Object.keys(metadata).some((key) => key !== "okf_version"))
        ) {
          reportError(
            file,
            "§8",
            "Only the bundle-root index may contain frontmatter, with okf_version only",
          );
        }
      } else if (basename === "log.md") {
        if (metadata)
          reportError(
            file,
            "§9",
            "log.md uses dated Markdown entries, without concept frontmatter",
          );
      } else if (!metadata || typeof metadata.type !== "string" || !metadata.type.trim()) {
        reportError(file, "§4.1", "Concept requires YAML frontmatter with a non-empty string type");
      }
    } catch (error) {
      reportError(file, "§4", error.message);
      continue;
    }
    const tree = fromMarkdown(body);
    if (basename === "log.md") {
      for (const entry of tree.children.filter(
        (node) => node.type === "heading" && node.depth === 2,
      )) {
        const date = entry.children.map((node) => node.value ?? "").join("");
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          !Number.isFinite(Date.parse(date)) ||
          new Date(date).toISOString().slice(0, 10) !== date
        ) {
          reportError(file, "§9", "Log date headings must use a valid YYYY-MM-DD date");
        }
      }
    }
    const definitions = new Map();
    const visit = (node, fn) => {
      fn(node);
      for (const child of node.children ?? []) visit(child, fn);
    };
    visit(tree, (node) => {
      if (node.type === "definition") definitions.set(node.identifier, node.url);
    });
    visit(tree, (node) => {
      const url =
        node.type === "link"
          ? node.url
          : node.type === "linkReference"
            ? definitions.get(node.identifier)
            : undefined;
      if (!url || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url)) return;
      let target;
      try {
        target = decodeURIComponent(url.split(/[?#]/, 1)[0]);
      } catch {
        links.push({ file, target: url, message: "Invalid URL encoding" });
        return;
      }
      if (!target.endsWith(".md")) return;
      const resolved = target.startsWith("/")
        ? path.resolve(root, `.${target}`)
        : path.resolve(path.dirname(full), target);
      const relative = path.relative(root, resolved);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        links.push({ file, target, message: "Link leaves the bundle" });
      } else if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        links.push({ file, target, message: "Target does not exist" });
      }
    });
  }
  return {
    spec: pinned.source,
    okfVersion: pinned.version,
    bundle: root,
    files: files.length,
    conformant: errors.length === 0,
    errors,
    linkIntegrity: { valid: links.length === 0, issues: links },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    let bundle = process.env.TENT_OKF_BUNDLE,
      workspace = false,
      json = false,
      checkLinks = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--json") json = true;
      else if (arg === "--check-links") checkLinks = true;
      else if (arg === "--workspace") {
        if (!args[i + 1] || args[i + 1].startsWith("--"))
          throw new Error("--workspace requires a project directory");
        bundle = path.join(args[++i], ".tent");
        workspace = true;
      } else if (!arg.startsWith("--") && !bundle) bundle = arg;
      else throw new Error(`Unknown or duplicate argument: ${arg}`);
    }
    bundle ??= path.resolve(import.meta.dirname, "../test/fixtures/okf-bundle");
    const result = validateBundle(bundle, { workspace });
    if (json) console.log(JSON.stringify(result));
    else {
      console.log(
        `Tent OKF ${result.okfVersion} structure: ${result.files} Markdown files, ${result.errors.length} error(s)`,
      );
      console.log(`Link integrity (separate): ${result.linkIntegrity.issues.length} issue(s)`);
      for (const issue of [...result.errors, ...result.linkIntegrity.issues])
        console.error(`${issue.file}: ${issue.message}${issue.target ? ` (${issue.target})` : ""}`);
    }
    process.exitCode = !result.conformant || (checkLinks && !result.linkIntegrity.valid) ? 1 : 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
