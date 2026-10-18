import path from "node:path";
import type {
  RepositoryImport,
  RepositoryImportIssue,
  RepositorySource,
} from "./repository-imports.js";
import { isJavaConfig, javaBuildRoots } from "./java-build.js";
import { javaTokens, type JavaToken } from "./java-lex.js";

type Import = { name: string; static: boolean; wildcard: boolean };
type Declaration = { package: string; types: string[]; nestedTypes: string[]; imports: Import[] };
const identifier = (token: JavaToken | undefined) => token?.kind === "word";

function declarations(file: RepositorySource, issues: RepositoryImportIssue[]): Declaration {
  const result: Declaration = { package: "", types: [], nestedTypes: [], imports: [] };
  if (file.content === undefined) return result;
  const issue = (reason: string) => issues.push({ file: file.path, reason });
  if (/\\u+[0-9a-fA-F]{4}/.test(file.content)) {
    issue("Java Unicode escape preprocessing is not supported");
    return result;
  }
  const { tokens: ts, errors } = javaTokens(file.content);
  for (const error of errors) issue(`Cannot parse Java source: ${error}`);
  const stack: Array<string | undefined> = [];
  let pendingType: string | undefined;
  let parentheses = 0;
  let packageSeen = false;
  for (let i = 0; i < ts.length; i++) {
    const token = ts[i]!;
    if (token.kind === "string") continue;
    if (
      stack.length === 0 &&
      token.kind === "word" &&
      ["import", "package"].includes(token.value)
    ) {
      let j = i + 1;
      const isStatic = token.value === "import" && ts[j]?.value === "static";
      if (isStatic) j++;
      const parts: string[] = [];
      if (identifier(ts[j])) parts.push(ts[j++]!.value);
      while (ts[j]?.value === "." && (identifier(ts[j + 1]) || ts[j + 1]?.value === "*")) {
        parts.push(ts[j + 1]!.value);
        j += 2;
        if (parts[parts.length - 1] === "*") break;
      }
      if (
        !parts.length ||
        ts[j]?.value !== ";" ||
        (token.value === "package" && parts.includes("*"))
      ) {
        issue(`Cannot parse Java ${token.value} declaration`);
        continue;
      }
      if (token.value === "package") {
        if (packageSeen || result.types.length)
          issue("Ambiguous or misplaced Java package declaration");
        result.package = parts.join(".");
        packageSeen = true;
      } else {
        const wildcard = parts[parts.length - 1] === "*";
        if (wildcard) parts.pop();
        result.imports.push({ name: parts.join("."), static: isStatic, wildcard });
      }
      i = j;
    } else if (
      token.kind === "word" &&
      ["class", "interface", "enum", "record"].includes(token.value) &&
      ts[i - 1]?.value !== "." &&
      identifier(ts[i + 1]) &&
      (token.value !== "record" || ["(", "<"].includes(ts[i + 2]?.value ?? ""))
    ) {
      const name = ts[i + 1]!.value;
      if (stack.every((scope) => scope !== undefined)) {
        const qualified = [result.package, ...stack, name].filter(Boolean).join(".");
        result.types.push(qualified);
        if (stack.length) result.nestedTypes.push(qualified);
        pendingType = name;
      }
      i++;
    } else if (token.value === "{") {
      stack.push(parentheses === 0 ? pendingType : undefined);
      if (parentheses === 0) pendingType = undefined;
    } else if (token.value === "}") {
      if (!stack.length) issue("Cannot parse Java source: unmatched closing brace");
      else stack.pop();
    } else if (token.value === ";") pendingType = undefined;
    else if (token.value === "(") parentheses++;
    else if (token.value === ")") parentheses--;
  }
  if (stack.length) issue("Cannot parse Java source: unclosed declaration body");
  return result;
}

/** Local declaration evidence, never classpath loading or compiler execution. */
export function extractJavaImports(
  files: readonly RepositorySource[],
  focusedFiles?: readonly string[],
) {
  const edges: RepositoryImport[] = [];
  const issues: RepositoryImportIssue[] = [];
  const requiredFiles = new Set<string>();
  const focus = focusedFiles ? new Set(focusedFiles) : undefined;
  const sources = files.filter((file) => file.path.endsWith(".java"));
  if (!sources.length || focus?.size === 0) return { edges, issues, requiredFiles: [] as string[] };
  if (focus) {
    for (const file of files) {
      if (!isJavaConfig(file.path)) continue;
      const directory = path.posix.dirname(file.path);
      if ([...focus].some((member) => directory === "." || member.startsWith(directory + "/")))
        requiredFiles.add(file.path);
    }
  }
  const roots = javaBuildRoots(files, issues, focus);
  const parsed = new Map<string, Declaration>();
  const parseIssues = new Map<string, RepositoryImportIssue[]>();
  for (const file of sources) {
    if (file.content === undefined) {
      if (!focus || focus.has(file.path))
        issues.push({ file: file.path, reason: "Java source bytes are unavailable" });
      continue;
    }
    // Supporting files provide declarations, not imports from outside the material.
    const sourceIssues: RepositoryImportIssue[] = [];
    parsed.set(file.path, declarations(file, sourceIssues));
    parseIssues.set(file.path, sourceIssues);
    if (!focus || focus.has(file.path)) issues.push(...sourceIssues);
    if ((!focus || focus.has(file.path)) && /(^|\/)module-info\.java$/.test(file.path))
      issues.push({ file: file.path, reason: "Java JPMS module declarations are not resolved" });
  }
  if (focus) {
    for (const file of sources.filter((source) => focus.has(source.path))) {
      const declaration = parsed.get(file.path);
      if (!declaration) continue;
      for (const imported of declaration.imports) {
        if (imported.wildcard && !imported.static) continue;
        const parts = imported.name.split(".");
        if (imported.static && !imported.wildcard) parts.pop();
        // A declaration may be in a differently named compilation unit. Read
        // the candidate package's direct files, including nested-type prefixes.
        for (let n = 2; n <= parts.length; n++) {
          const packagePath = parts.slice(0, n - 1).join("/");
          const directories = new Set([...roots].map((root) => path.posix.join(root, packagePath)));
          for (const candidate of sources) {
            const directory = path.posix.dirname(candidate.path);
            if (
              directories.has(directory) ||
              (packagePath && (directory === packagePath || directory.endsWith("/" + packagePath)))
            )
              requiredFiles.add(candidate.path);
          }
        }
      }
    }
  }
  if (focus)
    for (const required of requiredFiles)
      if (!focus.has(required)) issues.push(...(parseIssues.get(required) ?? []));
  const types = new Map<string, Set<string>>();
  const nestedTypes = new Map<string, Set<string>>();
  for (const [file, declaration] of parsed) {
    for (const name of declaration.types) {
      const definitions = types.get(name) ?? new Set<string>();
      definitions.add(file);
      types.set(name, definitions);
    }
    for (const name of declaration.nestedTypes) {
      const definitions = nestedTypes.get(name) ?? new Set<string>();
      definitions.add(file);
      nestedTypes.set(name, definitions);
    }
  }
  for (const file of sources) {
    if (focus && !focus.has(file.path)) continue;
    const declaration = parsed.get(file.path);
    if (!declaration) continue;
    for (const imported of declaration.imports) {
      const specifier = `${imported.static ? "static " : ""}${imported.name}${imported.wildcard ? ".*" : ""}`;
      const issue = (reason: string) => issues.push({ file: file.path, specifier, reason });
      if (imported.wildcard && !imported.static) {
        if (!/^(?:java|javax|jdk)\./.test(imported.name))
          issue("Java package wildcard import does not identify a dependency file");
        continue;
      }
      const name =
        imported.static && !imported.wildcard
          ? imported.name.slice(0, imported.name.lastIndexOf("."))
          : imported.name;
      // Static single imports may name a nested type; otherwise the final name
      // is a member and its declaring type is the dependency evidence.
      const targets =
        imported.static && !imported.wildcard
          ? (nestedTypes.get(imported.name) ?? types.get(name))
          : types.get(name);
      if (targets?.size === 1) {
        const to = [...targets][0]!;
        if (to !== file.path)
          edges.push({ from: file.path, to, kind: "file", specifier, execution: "compile-time" });
      } else if (targets?.size)
        issue("Java imported type has multiple local definitions; classpath is unknown");
      else if (!/^(?:java|javax|jdk)\./.test(imported.name))
        issue("Java import has no known local type; external classpath is not resolved");
    }
  }
  return { edges, issues, requiredFiles: [...requiredFiles].sort() };
}
