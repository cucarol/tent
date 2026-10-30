import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { parse } from "yaml";

export const hosts = ["codex", "claude-code"];

/** Each host shell's own Agent documents, by the package path they take. */
export const hostDocuments = {
  "host-hooks.md": "skills/tent-init/references/host-hooks.md",
  "host-role.md": "skills/tent-role/references/host-role.md",
};

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

// Parse Markdown so inline/fenced command examples are not mistaken for file links.
function links(tree, definitionsTree = tree) {
  const definitions = new Map();
  walk(definitionsTree, (node) => {
    if (node.type === "definition") definitions.set(node.identifier, node.url);
  });
  const result = [];
  walk(tree, (node) => {
    if (node.type === "link" || node.type === "image") result.push(node.url);
    if (node.type === "linkReference" || node.type === "imageReference") {
      const target = definitions.get(node.identifier);
      check(target, `Unresolved Markdown reference: ${node.identifier}`);
      result.push(target);
    }
  });
  return result;
}

export function validateSkill(file, text) {
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  check(frontmatter, `${file}: missing Skill frontmatter`);
  const metadata = parse(frontmatter[1]);
  check(
    typeof metadata?.name === "string" && /^[a-z0-9-]{1,64}$/.test(metadata.name),
    `${file}: name must use 1–64 lowercase letters, digits or hyphens`,
  );
  check(metadata.name === path.posix.basename(path.posix.dirname(file)), `${file}: name mismatch`);
  const description = metadata.description;
  check(
    typeof description === "string" && description.trim().length > 0 && description.length <= 1024,
    `${file}: description must contain 1–1024 characters`,
  );
  check(!/<[^>]*>/.test(description), `${file}: description contains XML tags`);
  // Current English descriptions begin with a third-person action (Creates, Reads, ...).
  check(
    /^[A-Za-z]+s\b/.test(description) && !/^(?:I|We|You|Use|This|These)\b/i.test(description),
    `${file}: description must describe the Skill in third person`,
  );
  const body = text.slice(frontmatter[0].length);
  const lines = body.trimEnd().split(/\r?\n/).length;
  check(lines < 500, `${file}: Skill body has ${lines} lines (must be below 500)`);
  return body;
}

export function validateDocuments(documents) {
  for (const [file, text] of documents) {
    const skill = file.endsWith("/SKILL.md");
    const body = skill ? validateSkill(file, text) : text;
    const tree = fromMarkdown(body);
    for (const link of links(tree)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith("#")) continue;
      const target = decodeURIComponent(link.split("#")[0]);
      if (!target.endsWith(".md")) continue;
      check(skill, `${file}: references must not link other Markdown files`);
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
      check(
        /(?:^|\/)references\//.test(resolved) && documents.has(resolved),
        `${file}: missing or non-reference target ${link}`,
      );
    }
    if (!skill && body.trimEnd().split(/\r?\n/).length > 100) {
      const beginning = { type: "root", children: tree.children.slice(0, 4) };
      let hasContents = false;
      walk(beginning, (node) => {
        if (node.type === "list" && links(node, tree).some((target) => target.startsWith("#")))
          hasContents = true;
      });
      check(
        hasContents,
        `${file}: a reference over 100 lines needs a table of contents at the start`,
      );
    }
  }
}

export async function readAgentDocuments(root) {
  const documents = new Map();
  for (const directory of ["skills", "skill-resources/references"]) {
    for (const file of await fs.readdir(path.join(root, directory), { recursive: true })) {
      const relative = `${directory}/${file.replaceAll("\\", "/")}`;
      if (relative.endsWith("/SKILL.md") || /\/references\/.*\.md$/.test(relative))
        documents.set(relative, await fs.readFile(path.join(root, relative), "utf8"));
    }
  }
  return documents;
}

export async function validateCommonDocuments(root) {
  const documents = await readAgentDocuments(root);
  for (const [file, text] of documents)
    check(!/\b(?:codex|claude(?:[ -]code)?)\b/i.test(text), `${file}: common text names a host`);
  return documents;
}

export async function validateSourceDocuments(root, host) {
  const documents = await validateCommonDocuments(root);
  for (const [name, target] of Object.entries(hostDocuments))
    documents.set(
      target,
      await fs.readFile(path.join(root, "plugins", host, "tent", name), "utf8"),
    );
  validateDocuments(documents);
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function validateHostPackage(root, host) {
  validateDocuments(await readAgentDocuments(root));
  const hooks = JSON.parse(await fs.readFile(path.join(root, "hooks/hooks.json"), "utf8")).hooks;
  check(
    JSON.stringify(Object.keys(hooks).sort()) ===
      JSON.stringify(["PostToolUse", "SessionStart", "Stop", "UserPromptSubmit"]),
    `${host}: expected tool, start, prompt and stop hooks`,
  );
  const variable = host === "codex" ? "PLUGIN_ROOT" : "CLAUDE_PLUGIN_ROOT";
  const realRoot = await fs.realpath(root);
  for (const [event, entries] of Object.entries(hooks)) {
    check(entries.length > 0, `${host}: missing ${event} command`);
    for (const entry of entries) {
      check(entry.hooks.length > 0, `${host}: missing ${event} command`);
      for (const hook of entry.hooks) {
        check(hook.type === "command" && !hook.async, `${host}: expected synchronous command`);
        const command = hook.command;
        const match = command.match(/path'\)\.join\(process\.env\.([A-Z_]+)((?:,'[^']+')+)\)/);
        check(match && match[1] === variable, `${host}: Hook must use ${variable}`);
        const segments = [...match[2].matchAll(/,'([^']+)'/g)].map((item) => item[1]);
        const filename = path.resolve(root, ...segments);
        check(
          inside(realRoot, await fs.realpath(filename)),
          `${host}: Hook points outside the package`,
        );
        check((await fs.stat(filename)).isFile(), `${host}: Hook launcher is not a file`);
        const action = {
          SessionStart: "start",
          PostToolUse: "tool",
          UserPromptSubmit: "prompt",
          Stop: "stop",
        }[event];
        check(command.endsWith(` -- ${action}`), `${host}: wrong Hook action`);
        const launcher = await fs.readFile(filename, "utf8");
        check(launcher.includes(`"--host", "${host}"`), `${host}: launcher must fix its host`);
        const runtime = launcher.match(/new URL\("([^"]+)", import\.meta\.url\)/)?.[1];
        check(runtime, `${host}: missing local CLI reference`);
        const runtimePath = await fs.realpath(path.resolve(path.dirname(filename), runtime));
        check(inside(realRoot, runtimePath), `${host}: CLI points outside the package`);
      }
    }
  }
}
