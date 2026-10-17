import path from "node:path";
import type {
  RepositorySource,
  RepositoryImport,
  RepositoryImportIssue,
} from "./repository-imports.js";
import { phpTokens, type PhpToken } from "./php-lex.js";

export const isPhpConfig = (file: string) => /(^|\/)composer\.json$/.test(file);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const localPath = (file: string) =>
  file !== ".." &&
  !file.startsWith("../") &&
  !path.posix.isAbsolute(file) &&
  !/[\\\0]|^[A-Za-z][A-Za-z0-9+.-]*:/.test(file);
const identifier = (token: PhpToken | undefined) =>
  token?.kind === "word" && /^[A-Za-z_\x80-\uffff][A-Za-z_\x80-\uffff0-9]*$/.test(token.value);
type Use = { name: string; kind: "class" | "function" | "const" };
type Mapping = { prefix: string; directory: string };

function composer(file: RepositorySource, issues: RepositoryImportIssue[]): Mapping[] {
  const issue = (reason: string) => issues.push({ file: file.path, reason });
  if (file.content === undefined) {
    issue("Required PHP Composer configuration bytes are unavailable");
    return [];
  }
  let json: unknown;
  try {
    json = JSON.parse(file.content);
  } catch {
    issue("Cannot parse PHP Composer configuration");
    return [];
  }
  if (!record(json)) {
    issue("Invalid PHP Composer configuration");
    return [];
  }
  const mappings: Mapping[] = [];
  for (const section of ["autoload", "autoload-dev"]) {
    const autoload = json[section];
    if (autoload === undefined) continue;
    if (!record(autoload)) {
      issue(`Invalid PHP Composer ${section} configuration`);
      continue;
    }
    if (Object.keys(autoload).some((key) => key !== "psr-4"))
      issue(`PHP Composer ${section} strategies other than PSR-4 are not evaluated`);
    const psr4 = autoload["psr-4"];
    if (psr4 === undefined) continue;
    if (!record(psr4)) {
      issue(`Invalid PHP Composer ${section} PSR-4 mapping`);
      continue;
    }
    for (const [prefix, raw] of Object.entries(psr4)) {
      const directories = typeof raw === "string" ? [raw] : raw;
      if (
        (prefix !== "" && !/^(?:[A-Za-z_\x80-\uffff][A-Za-z_\x80-\uffff0-9]*\\)+$/.test(prefix)) ||
        !Array.isArray(directories) ||
        !directories.length ||
        directories.some((dir) => typeof dir !== "string")
      ) {
        issue(`Invalid PHP Composer ${section} PSR-4 mapping`);
        continue;
      }
      for (const directory of directories as string[]) {
        const target = path.posix.join(path.posix.dirname(file.path), directory);
        if (
          path.posix.isAbsolute(directory) ||
          /[\\\0]|^[A-Za-z][A-Za-z0-9+.-]*:/.test(directory) ||
          !localPath(target)
        ) {
          issue("PHP Composer PSR-4 directory is not a static Workspace-local path");
          continue;
        }
        mappings.push({ prefix, directory: target });
      }
    }
  }
  if (json["include-path"] !== undefined || json["target-dir"] !== undefined)
    issue("PHP Composer include-path and target-dir are not evaluated");
  return mappings;
}

function useNames(tokens: PhpToken[]): Use[] | undefined {
  let i = 0;
  const result: Use[] = [];
  const kind = (): Use["kind"] => {
    const value = tokens[i]?.value.toLowerCase();
    if (value === "function" || value === "const") {
      i++;
      return value;
    }
    return "class";
  };
  const name = () => {
    let value = "";
    if (tokens[i]?.value === "\\") i++;
    if (!identifier(tokens[i])) return undefined;
    value += tokens[i++]!.value;
    while (tokens[i]?.value === "\\") {
      i++;
      value += "\\";
      if (!identifier(tokens[i])) break;
      value += tokens[i++]!.value;
    }
    return value;
  };
  const alias = () => {
    if (tokens[i]?.value.toLowerCase() !== "as") return true;
    i++;
    if (!identifier(tokens[i])) return false;
    i++;
    return true;
  };
  const baseKind = kind();
  while (i < tokens.length) {
    const prefix = name();
    if (!prefix) return;
    if (tokens[i]?.value === "{") {
      if (!prefix.endsWith("\\")) return;
      i++;
      while (i < tokens.length && tokens[i]?.value !== "}") {
        const memberKind = kind();
        const member = name();
        if (!member || member.endsWith("\\") || !alias()) return;
        result.push({
          name: prefix + member,
          kind: memberKind === "class" ? baseKind : memberKind,
        });
        if (tokens[i]?.value !== ",") break;
        i++;
      }
      if (tokens[i++]?.value !== "}") return;
    } else {
      if (prefix.endsWith("\\") || !alias()) return;
      result.push({ name: prefix, kind: baseKind });
    }
    if (i === tokens.length) break;
    if (tokens[i++]?.value !== ",") return;
  }
  return result.length ? result : undefined;
}

type StaticPath = { value: string; anchored: boolean };
function includePath(tokens: PhpToken[], start: number, file: string) {
  let i = start;
  let nesting = 0;
  function expression(): StaticPath | undefined {
    let value = primary();
    if (!value) return;
    while (tokens[i]?.value === ".") {
      if (!value.anchored) return;
      i++;
      const next = primary();
      if (!next || next.anchored) return;
      value = { value: value.value + next.value, anchored: true };
    }
    return value;
  }
  function primary(): StaticPath | undefined {
    const token = tokens[i++];
    if (token?.kind === "string") return { value: token.value, anchored: false };
    const lower = token?.kind === "word" ? token.value.toLowerCase() : "";
    if (lower === "__dir__") return { value: path.posix.dirname(file), anchored: true };
    if (token?.value === "(") {
      if (++nesting > 64) return;
      const value = expression();
      nesting--;
      if (tokens[i++]?.value === ")") return value;
      return;
    }
    if (
      lower === "dirname" &&
      tokens[i]?.value === "(" &&
      tokens[i + 1]?.kind === "word" &&
      tokens[i + 1]?.value.toLowerCase() === "__file__" &&
      tokens[i + 2]?.value === ")"
    ) {
      i += 3;
      return { value: path.posix.dirname(file), anchored: true };
    }
    return;
  }
  const value = expression();
  if (tokens[i] && ![";", ")", "]", ","].includes(tokens[i]!.value)) return;
  return value;
}

function references(file: RepositorySource, issues: RepositoryImportIssue[]) {
  const { tokens, errors } = phpTokens(file.content!);
  const uses: Use[] = [];
  const includes: StaticPath[] = [];
  const issue = (reason: string) => issues.push({ file: file.path, reason });
  for (const error of errors) issue(`Cannot parse PHP source: ${error}`);
  let depth = 0;
  let namespaceDepth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const lower = token.kind === "word" ? token.value.toLowerCase() : "";
    const member = ["->", "::", "\\"].includes(tokens[i - 1]?.value ?? "");
    const statement = i === 0 || [";", "{", "}"].includes(tokens[i - 1]?.value ?? "");
    if (lower === "namespace" && statement && depth === 0 && tokens[i + 1]?.value !== "\\") {
      let j = i + 1;
      while (j < tokens.length && ![";", "{"].includes(tokens[j]!.value)) j++;
      if (tokens[j]?.value === "{") {
        depth++;
        namespaceDepth = depth;
      } else namespaceDepth = 0;
      if (j === tokens.length) issue("Cannot parse PHP namespace declaration");
      i = j;
    } else if (
      lower === "use" &&
      statement &&
      depth === namespaceDepth &&
      tokens[i + 1]?.value !== "("
    ) {
      let end = i + 1;
      while (end < tokens.length && tokens[end]?.value !== ";") end++;
      const names = useNames(tokens.slice(i + 1, end));
      if (end === tokens.length || !names) issue("Cannot parse PHP namespace use declaration");
      else uses.push(...names);
      i = end;
    } else if (
      lower === "use" &&
      statement &&
      depth > namespaceDepth &&
      tokens[i + 1]?.value !== "("
    ) {
      issue("PHP trait insertion use is not resolved");
    } else if (["require", "require_once", "include", "include_once"].includes(lower) && !member) {
      if (
        ["function", "const"].includes(tokens[i - 1]?.value.toLowerCase() ?? "") ||
        tokens[i + 1]?.value === ":" ||
        (tokens[i - 1]?.value === "&" && tokens[i - 2]?.value.toLowerCase() === "function")
      )
        continue;
      const target = includePath(tokens, i + 1, file.path);
      if (target) includes.push(target);
      else issue("PHP include/require expression is not a supported static path");
    } else if (token.kind === "symbol" && token.value === "{") depth++;
    else if (token.kind === "symbol" && token.value === "}") {
      depth--;
      if (depth < namespaceDepth) namespaceDepth = 0;
      if (depth < 0) {
        issue("Cannot parse PHP source: unmatched closing brace");
        depth = 0;
      }
    }
  }
  if (depth) issue("Cannot parse PHP source: unclosed body");
  return { uses, includes };
}

/** Pure source evidence with conventional PSR-4 mapping; never runs PHP or Composer. */
export function extractPhpImports(input: readonly RepositorySource[], focus?: readonly string[]) {
  const files = [...input].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const byPath = new Map(files.map((file) => [file.path, file]));
  const issues: RepositoryImportIssue[] = [];
  const edges: RepositoryImport[] = [];
  const requiredFiles = new Set<string>();
  const sources = files.filter(
    (file) => file.path.endsWith(".php") && (focus === undefined || focus.includes(file.path)),
  );
  const configs = files.filter((file) => isPhpConfig(file.path));
  const mappings = new Map<string, Mapping[]>();
  for (const file of sources) {
    requiredFiles.add(file.path);
    const config = configs
      .filter((config) => {
        const dir = path.posix.dirname(config.path);
        return dir === "." || file.path.startsWith(dir + "/");
      })
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (config && !mappings.has(config.path)) {
      requiredFiles.add(config.path);
      mappings.set(config.path, composer(config, issues));
    }
    if (file.content === undefined) {
      issues.push({ file: file.path, reason: "Required PHP source bytes are unavailable" });
      continue;
    }
    const refs = references(file, issues);
    const issue = (specifier: string, reason: string) =>
      issues.push({ file: file.path, specifier, reason });
    const add = (to: string, specifier: string) => {
      if (to !== file.path) edges.push({ from: file.path, to, kind: "file", specifier });
    };
    for (const imported of refs.uses) {
      if (imported.kind !== "class") {
        issue(
          `${imported.kind} ${imported.name}`,
          "PHP function/constant namespace imports do not identify PSR-4 files",
        );
        continue;
      }
      const candidates = (config ? mappings.get(config.path)! : [])
        .filter((mapping) => imported.name.startsWith(mapping.prefix))
        .sort((a, b) => b.prefix.length - a.prefix.length);
      const target = candidates
        .map((mapping) =>
          path.posix.join(
            mapping.directory,
            imported.name.slice(mapping.prefix.length).replace(/\\/g, "/") + ".php",
          ),
        )
        .find((candidate) => localPath(candidate) && byPath.has(candidate));
      if (target) add(target, imported.name);
      else
        issue(
          imported.name,
          "PHP namespace use has no local PSR-4 file; namespace aliases and external autoloaders are not resolved",
        );
    }
    for (const included of refs.includes) {
      const specifier = included.value;
      if (!included.anchored) {
        if (
          path.posix.isAbsolute(specifier) ||
          /[\\\0]|^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier)
        ) {
          issue(specifier, "PHP include/require path is outside supported Workspace-local paths");
          continue;
        }
        const candidates = [
          ...new Set([
            path.posix.join(path.posix.dirname(file.path), specifier),
            path.posix.normalize(specifier),
          ]),
        ].filter((candidate) => localPath(candidate) && byPath.has(candidate));
        for (const candidate of candidates) {
          add(candidate, specifier);
          issue(
            specifier,
            `PHP include/require candidate ${candidate}: runtime include_path and working directory are not evaluated`,
          );
        }
        if (!candidates.length)
          issue(
            specifier,
            "PHP include/require has no supplied source-directory or Workspace-root candidate; runtime include_path and working directory are not evaluated",
          );
        continue;
      }
      const candidate = path.posix.normalize(specifier);
      if (!localPath(candidate)) {
        issue(specifier, "PHP include/require path is outside supported Workspace-local paths");
        continue;
      }
      if (byPath.has(candidate)) add(candidate, specifier);
      else issue(specifier, "PHP include/require target is absent from supplied local files");
    }
  }
  return { edges, issues, requiredFiles: [...requiredFiles].sort() };
}
