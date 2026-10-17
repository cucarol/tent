import type {
  RepositoryImport,
  RepositoryImportIssue,
  RepositorySource,
} from "./repository-imports.js";
import { csharpProjects } from "./csharp-build.js";
import { csharpTokens, type CSharpToken } from "./csharp-lex.js";

type Import = {
  name: string;
  scope: string;
  static: boolean;
  alias?: string;
  absolute: boolean;
  global: boolean;
};
type Declaration = { types: string[]; namespaces: string[]; imports: Import[] };
type Scope = { kind: "namespace" | "type" | "body"; name: string };
const keyword = (token: CSharpToken | undefined, value: string) =>
  token?.kind === "word" && !token.escaped && token.value === value;
const word = (token: CSharpToken | undefined) => token?.kind === "word";

function declarations(file: RepositorySource, issues: RepositoryImportIssue[]): Declaration {
  const result: Declaration = { types: [], namespaces: [], imports: [] };
  if (file.content === undefined) return result;
  const issue = (reason: string) => issues.push({ file: file.path, reason });
  const { tokens: ts, errors } = csharpTokens(file.content);
  for (const error of errors) issue(`Cannot parse C# source: ${error}`);
  if (/\\[uU][0-9a-fA-F]{4}/.test(file.content))
    issue("C# Unicode escape identifiers are not resolved");
  const stack: Scope[] = [];
  let fileNamespace = "";
  let pending: Scope | undefined;
  let parentheses = 0;
  const namespace = () =>
    [
      fileNamespace,
      ...stack.filter((scope) => scope.kind === "namespace").map((scope) => scope.name),
    ]
      .filter(Boolean)
      .join(".");
  const declarationScope = () => stack.every((scope) => scope.kind !== "body");
  function nameAt(start: number) {
    let j = start;
    const absolute =
      keyword(ts[j], "global") && ts[j + 1]?.value === ":" && ts[j + 2]?.value === ":";
    if (absolute) j += 3;
    const parts: string[] = [];
    if (word(ts[j])) parts.push(ts[j++]!.value);
    while (ts[j]?.value === "." && word(ts[j + 1])) {
      parts.push(ts[j + 1]!.value);
      j += 2;
    }
    return { name: parts.join("."), end: j, absolute };
  }
  for (let i = 0; i < ts.length; i++) {
    const token = ts[i]!;
    if (token.kind === "string") continue;
    if (keyword(token, "extern") && keyword(ts[i + 1], "alias"))
      issue("C# extern alias is not resolved");
    if (keyword(token, "namespace") && declarationScope()) {
      const name = nameAt(i + 1);
      if (!name.name || !["{", ";"].includes(ts[name.end]?.value ?? "")) {
        issue("Cannot parse C# namespace declaration");
        continue;
      }
      const qualified = [namespace(), name.name].filter(Boolean).join(".");
      result.namespaces.push(qualified);
      if (ts[name.end]?.value === ";") fileNamespace = qualified;
      else stack.push({ kind: "namespace", name: name.name });
      i = name.end;
      continue;
    }
    if (keyword(token, "using") && stack.every((scope) => scope.kind === "namespace")) {
      let j = i + 1;
      if (ts[j]?.value === "(" || keyword(ts[j], "var")) continue;
      const isStatic = keyword(ts[j], "static");
      if (isStatic) j++;
      const alias = word(ts[j]) && ts[j + 1]?.value === "=" ? ts[j]!.value : undefined;
      if (alias) j += 2;
      if (keyword(ts[j], "unsafe")) j++;
      const name = nameAt(j);
      if (!name.name || ts[name.end]?.value !== ";") {
        // A top-level using resource declaration has a type then a variable.
        if (!alias && !isStatic && word(ts[name.end])) continue;
        issue("Cannot resolve C# using directive statically");
        continue;
      }
      result.imports.push({
        name: name.name,
        scope: namespace(),
        static: isStatic,
        alias,
        absolute: name.absolute,
        global: keyword(ts[i - 1], "global"),
      });
      i = name.end;
      continue;
    }
    if (
      declarationScope() &&
      token.kind === "word" &&
      !token.escaped &&
      ["class", "struct", "interface", "enum", "record", "delegate"].includes(token.value) &&
      ts[i - 1]?.value !== "."
    ) {
      let j = i + 1;
      if (token.value === "record" && (keyword(ts[j], "class") || keyword(ts[j], "struct"))) j++;
      if (token.value === "delegate") {
        while (j < ts.length && !["(", ";", "{"].includes(ts[j]!.value)) j++;
        j--;
        // Generic delegates have their name before the type parameter list.
        if (ts[j]?.value === ">") {
          let depth = 1;
          while (--j >= i && depth) {
            if (ts[j]?.value === ">") depth++;
            if (ts[j]?.value === "<") depth--;
          }
        }
      }
      if (!word(ts[j])) continue;
      const name = ts[j]!.value;
      const qualified = [
        namespace(),
        ...stack.filter((scope) => scope.kind === "type").map((scope) => scope.name),
        name,
      ]
        .filter(Boolean)
        .join(".");
      result.types.push(qualified);
      if (token.value !== "delegate") pending = { kind: "type", name };
      i = j;
    } else if (token.value === "{") {
      stack.push(parentheses === 0 && pending ? pending : { kind: "body", name: "" });
      if (parentheses === 0) pending = undefined;
    } else if (token.value === "}") {
      if (!stack.length) issue("Cannot parse C# source: unmatched closing brace");
      else stack.pop();
    } else if (token.value === ";") pending = undefined;
    else if (token.value === "(") parentheses++;
    else if (token.value === ")") parentheses--;
  }
  if (stack.length) issue("Cannot parse C# source: unclosed declaration body");
  return result;
}

/** Static using evidence; no compiler, generated sources or namespace fan-out. */
export function extractCSharpImports(
  files: readonly RepositorySource[],
  focusedFiles?: readonly string[],
) {
  const edges: RepositoryImport[] = [];
  const issues: RepositoryImportIssue[] = [];
  const sources = files.filter((file) => file.path.endsWith(".cs"));
  const focus = focusedFiles ? new Set(focusedFiles) : undefined;
  if (!sources.length || focus?.size === 0) return { edges, issues, requiredFiles: [] as string[] };
  const projects = csharpProjects(files, issues, focus);
  const requiredFiles = projects.requiredFiles;
  const eligible = (from: string, to: string) => {
    const reachable = projects.reachable(from);
    return (
      !projects.owners(from).length || projects.owners(to).some((owner) => reachable.has(owner))
    );
  };
  if (focus)
    for (const file of sources)
      if ([...focus].some((from) => eligible(from, file.path))) requiredFiles.add(file.path);
  const parsed = new Map<string, Declaration>();
  for (const file of sources) {
    if (focus && !requiredFiles.has(file.path)) continue;
    if (file.content === undefined) {
      issues.push({ file: file.path, reason: "C# source bytes are unavailable" });
      continue;
    }
    parsed.set(file.path, declarations(file, issues));
  }
  const types = new Map<string, Set<string>>();
  const namespaces = new Map<string, Set<string>>();
  for (const [filename, declaration] of parsed) {
    for (const name of declaration.types) {
      const definitions = types.get(name) ?? new Set<string>();
      definitions.add(filename);
      types.set(name, definitions);
    }
    for (const name of [
      ...declaration.namespaces,
      ...declaration.types.map((name) =>
        name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : "",
      ),
    ]) {
      const parts = name.split(".");
      while (parts.length && parts[0]) {
        const namespace = parts.join(".");
        const definitions = namespaces.get(namespace) ?? new Set<string>();
        definitions.add(filename);
        namespaces.set(namespace, definitions);
        parts.pop();
      }
    }
  }
  for (const file of sources) {
    if (focus && !focus.has(file.path)) continue;
    if (projects.owners(file.path).length > 1)
      issues.push({
        file: file.path,
        reason: "Multiple C# projects share the source directory; compilation context is ambiguous",
      });
    for (const imported of parsed.get(file.path)?.imports ?? []) {
      const specifier = `${imported.global ? "global " : ""}${imported.static ? "static " : imported.alias ? imported.alias + " = " : ""}${imported.absolute ? "global::" : ""}${imported.name}`;
      const issue = (reason: string) => issues.push({ file: file.path, specifier, reason });
      const scope = imported.scope.split(".").filter(Boolean);
      const names: string[] = [];
      if (!imported.absolute)
        for (let n = scope.length; n > 0; n--)
          names.push([...scope.slice(0, n), imported.name].join("."));
      names.push(imported.name);
      let targets: string[] = [];
      let namespaceImport = false;
      for (const name of names) {
        const candidates = [...(types.get(name) ?? [])].filter((target) =>
          eligible(file.path, target),
        );
        if (candidates.length) {
          targets = candidates;
          break;
        }
        if ([...(namespaces.get(name) ?? [])].some((target) => eligible(file.path, target))) {
          namespaceImport = true;
          break;
        }
      }
      if (targets.length === 1 && (imported.static || imported.alias)) {
        if (targets[0] !== file.path)
          edges.push({ from: file.path, to: targets[0]!, kind: "file", specifier });
      } else if (targets.length > 1)
        issue(
          "C# imported type has multiple local definitions, including possible partial declarations",
        );
      else if (namespaceImport || (!imported.static && !imported.alias)) {
        if (!/^System(?:\.|$)/.test(imported.name))
          issue("C# namespace using does not identify a dependency file");
      } else if (!/^System(?:\.|$)/.test(imported.name))
        issue("C# using has no known reachable local type; external assemblies are not resolved");
    }
  }
  return { edges, issues, requiredFiles: [...requiredFiles].sort() };
}
