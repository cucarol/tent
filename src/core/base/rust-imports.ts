import path from "node:path";
import type {
  RepositoryImport,
  RepositoryImportIssue,
  RepositorySource,
} from "./repository-imports.js";
import { rustCargo, rustCargoContext, type RustCrate } from "./rust-cargo.js";
import { rustGroupEnd, rustTokens, type RustToken } from "./rust-lex.js";

type Scope = { bindings: Map<string, Set<object>>; parent?: Scope };
type Module = {
  file: string;
  directory: string;
  parent?: Module;
  children: Map<string, Module>;
  items: Set<string>;
  enums: Map<string, Set<string>>;
  imports: Use[];
  aliases: Set<string>;
  ambiguous: Set<string>;
  scope: Scope;
  loaded: boolean;
};
type Use = {
  module: Module;
  segments: string[];
  specifier: string;
  absolute: boolean;
  scope: Scope;
  statement: object;
};
const word = (v: string) => /^[\p{L}_][\p{L}\p{N}_]*$/u.test(v);
const harmlessMacros = new Set([
  "assert",
  "assert_eq",
  "assert_ne",
  "debug_assert",
  "debug_assert_eq",
  "debug_assert_ne",
  "format",
  "format_args",
  "write",
  "writeln",
  "print",
  "println",
  "eprint",
  "eprintln",
  "panic",
  "unreachable",
  "unimplemented",
  "todo",
  "vec",
  "matches",
  "concat",
  "stringify",
  "env",
  "option_env",
  "file",
  "line",
  "column",
  "module_path",
  "cfg",
  "compile_error",
  "dbg",
]);
const opaqueMacros = new Set([
  "concat",
  "stringify",
  "env",
  "option_env",
  "file",
  "line",
  "column",
  "module_path",
  "cfg",
  "compile_error",
]);
const inertAttributes = new Set([
  "allow",
  "warn",
  "deny",
  "forbid",
  "expect",
  "doc",
  "repr",
  "inline",
  "cold",
  "must_use",
  "non_exhaustive",
  "track_caller",
  "deprecated",
  "no_mangle",
  "export_name",
  "link",
  "link_name",
  "link_section",
  "used",
  "test",
  "ignore",
  "should_panic",
  "automatically_derived",
  "unsafe",
]);
const builtInDerives = new Set([
  "Clone",
  "Copy",
  "Debug",
  "Default",
  "Eq",
  "Hash",
  "Ord",
  "PartialEq",
  "PartialOrd",
]);
const keywords = new Set([
  "as",
  "async",
  "await",
  "break",
  "const",
  "continue",
  "crate",
  "dyn",
  "else",
  "enum",
  "extern",
  "false",
  "fn",
  "for",
  "if",
  "impl",
  "in",
  "let",
  "loop",
  "match",
  "mod",
  "move",
  "mut",
  "pub",
  "ref",
  "return",
  "self",
  "Self",
  "static",
  "struct",
  "super",
  "trait",
  "true",
  "type",
  "unsafe",
  "use",
  "where",
  "while",
]);

/** Flatten use trees without interpreting aliases or expanding glob imports into symbols. */
function useTree(
  ts: readonly RustToken[],
): Array<{ segments: string[]; alias?: string; absolute: boolean }> | undefined {
  let i = 0;
  const out: Array<{ segments: string[]; alias?: string; absolute: boolean }> = [];
  function tree(prefix: string[], absolute: boolean): boolean {
    const parts = [...prefix];
    if (ts[i]?.value === "::") {
      if (parts.length) return false;
      absolute = true;
      i++;
    }
    while (i < ts.length) {
      const token = ts[i]!;
      if (token.string) return false;
      if (token.value === "{") {
        i++;
        while (ts[i]?.value !== "}") {
          if (!tree(parts, absolute)) return false;
          if (ts[i]?.value === ",") i++;
          else if (ts[i]?.value !== "}") return false;
        }
        i++;
        return true;
      }
      if (!word(token.value) && token.value !== "*") return false;
      parts.push(token.value);
      i++;
      if (ts[i]?.value === "::") {
        i++;
        continue;
      }
      let alias: string | undefined;
      if (ts[i]?.value === "as") {
        i++;
        if (!word(ts[i]?.value ?? "")) return false;
        alias = ts[i++]!.value;
      }
      const segments =
        parts.length > 1 && parts[parts.length - 1] === "self" ? parts.slice(0, -1) : parts;
      out.push({ segments, alias, absolute });
      return true;
    }
    return false;
  }
  return tree([], false) && i === ts.length ? out : undefined;
}

/** Static Rust module/import facts over caller-supplied bytes only. */
export function extractRustImports(
  files: readonly RepositorySource[],
  focusedFiles?: readonly string[],
  options: { includeTests?: boolean } = {},
) {
  const edges: RepositoryImport[] = [],
    issues: RepositoryImportIssue[] = [];
  const focus = focusedFiles ? new Set(focusedFiles) : undefined;
  const context = focus ? rustCargoContext(files, focus, options.includeTests) : undefined;
  const requiredFiles = new Set(context?.manifests);
  const sources = new Map(
    files.filter((file) => file.path.endsWith(".rs")).map((file) => [file.path, file]),
  );
  if (!sources.size || focus?.size === 0) return { edges, issues, requiredFiles: [] as string[] };
  const crates = rustCargo(
    context
      ? files.filter(
          (file) => !/(^|\/)Cargo\.toml$/.test(file.path) || context.manifests.has(file.path),
        )
      : files,
    issues,
    context?.packages,
    options.includeTests,
  );
  const visited = new Set<string>();
  const testOnly = new Set<string>();
  const macroDefinitions = new Set<string>();
  const knownMacroCalls: Array<{ module: Module; scope: Scope; name: string }> = [];
  const roots = new Map<RustCrate, Module[]>();
  const libraryRoots = new Map<RustCrate, Module>();
  const issue = (file: string, specifier: string, reason: string) =>
    issues.push({ file, specifier, reason });
  function moduleFor(file: string, directory: string, parent?: Module): Module {
    return {
      file,
      directory,
      parent,
      children: new Map(),
      items: new Set(),
      enums: new Map(),
      imports: [],
      aliases: new Set(),
      ambiguous: new Set(),
      scope: { bindings: new Map() },
      loaded: false,
    };
  }
  function edge(from: string, to: string, specifier: string) {
    if (from !== to) edges.push({ from, to, kind: "file", specifier });
  }
  function markTestModules(ts: readonly RustToken[], directory: string) {
    for (let i = 0; i < ts.length; i++) {
      if (ts[i]!.string) continue;
      if (ts[i + 1]?.value === "!" && word(ts[i]!.value)) {
        const start = ts[i]!.value === "macro_rules" ? i + 3 : i + 2;
        if (["{", "(", "["].includes(ts[start]?.value ?? "")) i = rustGroupEnd(ts, start) - 1;
      } else if (ts[i]?.value === "mod" && word(ts[i + 1]?.value ?? "")) {
        const name = ts[i + 1]!.value,
          childDirectory = path.posix.join(directory, name);
        if (ts[i + 2]?.value === "{") {
          const end = rustGroupEnd(ts, i + 2);
          markTestModules(ts.slice(i + 3, end - 1), childDirectory);
          i = end - 1;
        } else if (ts[i + 2]?.value === ";") {
          for (const candidate of [
            childDirectory + ".rs",
            path.posix.join(childDirectory, "mod.rs"),
          ]) {
            if (!sources.has(candidate) || testOnly.has(candidate)) continue;
            testOnly.add(candidate);
            if (
              focus &&
              [...focus].some((file) => file === candidate || file.startsWith(childDirectory + "/"))
            )
              requiredFiles.add(candidate);
            markTestModules(rustTokens(sources.get(candidate)?.content ?? ""), childDirectory);
          }
        }
      }
    }
  }
  function parseFile(module: Module, chain: Set<string>) {
    module.loaded = true;
    visited.add(module.file);
    requiredFiles.add(module.file);
    const source = sources.get(module.file);
    if (source?.content === undefined) {
      issue(module.file, module.file, "Required Rust source content is unavailable");
      return;
    }
    if (
      /(^|\/)(gen|generated|__generated__)\//.test(module.file) ||
      /^\s*\/\/[^\n]*(?:@generated|automatically generated)/im.test(source.content)
    ) {
      issue(module.file, module.file, "Generated Rust source requires generation context");
      return;
    }
    if (chain.has(module.file)) {
      issue(module.file, module.file, "Rust module declaration cycle is unsupported");
      return;
    }
    const ts = rustTokens(source.content);
    if (ts.some((token) => token.invalid))
      issue(module.file, module.file, "Rust source has an unterminated comment or literal");
    parse(ts, module, new Set([...chain, module.file]), true);
  }
  function parse(
    ts: readonly RustToken[],
    module: Module,
    chain: Set<string>,
    moduleLevel: boolean,
    scope: Scope = module.scope,
  ) {
    let i = 0;
    while (i < ts.length) {
      if (ts[i]!.string) {
        i++;
        continue;
      }
      let skip = false,
        testItem = false,
        innerSkip = false;
      const attributeIssueStart = issues.length;
      while (ts[i]?.value === "#" && ["[", "!"].includes(ts[i + 1]?.value ?? "")) {
        const inner = ts[i + 1]?.value === "!",
          start = i + (inner ? 2 : 1);
        if (ts[start]?.value !== "[") break;
        const end = rustGroupEnd(ts, start),
          attr = ts.slice(start + 1, end - 1),
          name = attr[0]?.value ?? "";
        if (
          name === "test" ||
          (name === "cfg" && attr.map((t) => t.value).join("") === "cfg(test)")
        ) {
          if (!options.includeTests || (focus && !focus.has(module.file))) {
            skip = true;
            testItem = true;
          }
        } else if (["cfg", "cfg_attr", "path"].includes(name)) {
          issue(module.file, name, "Rust conditional or path attribute requires compiler context");
          skip = true;
        } else if (name === "derive") {
          if (attr.slice(2, -1).some((t) => t.value !== "," && !builtInDerives.has(t.value)))
            issue(module.file, "derive", "Rust procedural derive may generate dependencies");
        } else if (!inertAttributes.has(name) && !["rustfmt", "clippy"].includes(name)) {
          issue(module.file, name, "Rust procedural attribute is unsupported");
          skip = true;
        }
        i = end;
        if (inner && skip) innerSkip = true;
      }
      if (testItem) issues.splice(attributeIssueStart);
      if (innerSkip) {
        if (testItem) markTestModules(ts.slice(i), module.directory);
        return;
      }
      if (skip) {
        const skippedStart = i;
        // Skip the entire attributed item, including any nested use/mod declarations.
        while (i < ts.length) {
          if (ts[i]!.string) {
            i++;
            continue;
          }
          const v = ts[i]!.value;
          if (!ts[i]!.string && ["{", "(", "["].includes(v)) {
            const end = rustGroupEnd(ts, i);
            i = end;
            if (v === "{") break;
          } else if (v === ";") {
            i++;
            break;
          } else i++;
        }
        if (testItem) markTestModules(ts.slice(skippedStart, i), module.directory);
        continue;
      }
      if (i >= ts.length) break;
      if (ts[i]?.value === "pub" && !ts[i]?.raw) {
        i++;
        if (ts[i]?.value === "(") i = rustGroupEnd(ts, i);
      }
      if (i >= ts.length) break;
      const value = ts[i]?.raw ? undefined : ts[i]?.value;
      if (value === "use") {
        let end = i + 1;
        while (end < ts.length && ts[end]?.value !== ";") end++;
        const tree = end < ts.length ? useTree(ts.slice(i + 1, end)) : undefined;
        if (!tree) issue(module.file, "use", "Cannot parse Rust use declaration");
        else {
          const statement = {};
          for (const entry of tree) {
            const specifier = (entry.absolute ? "::" : "") + entry.segments.join("::");
            module.imports.push({ module, ...entry, specifier, scope, statement });
            const binding = entry.alias ?? entry.segments[entry.segments.length - 1]!;
            const bindings = scope.bindings.get(binding) ?? new Set<object>();
            bindings.add(statement);
            scope.bindings.set(binding, bindings);
            if (moduleLevel) module.aliases.add(binding);
          }
        }
        i = end + 1;
        continue;
      }
      if (value === "mod" && word(ts[i + 1]?.value ?? "")) {
        const name = ts[i + 1]!.value,
          next = ts[i + 2]?.value;
        if (!moduleLevel) {
          issue(module.file, name, "Block-local Rust module resolution is unsupported");
          i = next === "{" ? rustGroupEnd(ts, i + 2) : i + 3;
          continue;
        } else if (module.children.has(name)) {
          issue(module.file, name, "Rust module name is ambiguous");
          module.ambiguous.add(name);
          i = next === "{" ? rustGroupEnd(ts, i + 2) : i + 3;
          continue;
        } else if (next === "{") {
          const end = rustGroupEnd(ts, i + 2),
            child = moduleFor(module.file, path.posix.join(module.directory, name), module);
          module.children.set(name, child);
          child.loaded = true;
          parse(ts.slice(i + 3, end - 1), child, chain, true);
          i = end;
          continue;
        } else if (next === ";") {
          const candidates = [
            path.posix.join(module.directory, name + ".rs"),
            path.posix.join(module.directory, name, "mod.rs"),
          ].filter((file) => sources.has(file));
          if (candidates.length !== 1)
            issue(
              module.file,
              name,
              candidates.length
                ? "Rust module has multiple source candidates"
                : "Rust module is absent from supplied production files",
            );
          else {
            const file = candidates[0]!,
              child = moduleFor(file, path.posix.join(module.directory, name), module);
            module.children.set(name, child);
            edge(module.file, file, `mod ${name}`);
            if (
              !focus ||
              [...focus].some(
                (file) => file === child.file || file.startsWith(child.directory + "/"),
              )
            )
              parseFile(child, chain);
          }
          i += 3;
          continue;
        }
      }
      if (value === "extern" && ts[i + 1]?.value === "crate") {
        issue(
          module.file,
          "extern crate",
          "Rust extern crate bindings require unsupported name resolution",
        );
        while (i < ts.length && ts[i]?.value !== ";") i++;
        i++;
        continue;
      }
      const macro = ts[i]!.value;
      if (
        ts[i + 1]?.value === "!" &&
        word(macro) &&
        (!keywords.has(macro) || ts[i]?.raw) &&
        (macro === "macro_rules" || ["{", "(", "["].includes(ts[i + 2]?.value ?? ""))
      ) {
        if (!harmlessMacros.has(macro) || ts[i - 1]?.value === "::")
          issue(module.file, macro, "Rust macro expansion may contain dependencies");
        else knownMacroCalls.push({ module, scope, name: macro });
        if (macro === "macro_rules" && ts[i + 2]) macroDefinitions.add(ts[i + 2]!.value);
        i += 2;
        if (macro === "macro_rules") i++;
        if (["{", "(", "["].includes(ts[i]?.value ?? "")) {
          const end = rustGroupEnd(ts, i);
          if (harmlessMacros.has(macro) && !opaqueMacros.has(macro)) {
            const body = ts.slice(i + 1, end - 1);
            if (
              body.some(
                (token) => !token.string && !token.raw && ["use", "mod"].includes(token.value),
              )
            )
              issue(
                module.file,
                macro,
                "Rust macro arguments contain dependency declarations requiring expansion context",
              );
            else parse(body, module, chain, false, scope);
          }
          i = end;
        }
        continue;
      }
      if (
        moduleLevel &&
        ["fn", "struct", "enum", "trait", "type", "const", "static", "union"].includes(
          value ?? "",
        ) &&
        word(ts[i + 1]?.value ?? "")
      ) {
        const name = ts[i + 1]!.value;
        module.items.add(name);
        if (value === "enum") {
          let start = i + 2;
          while (start < ts.length && (ts[start]!.string || !["{", ";"].includes(ts[start]!.value)))
            start++;
          if (ts[start]?.value === "{") {
            const end = rustGroupEnd(ts, start),
              variants = new Set<string>();
            let j = start + 1,
              expectVariant = true,
              conditionalVariant = false;
            while (j < end - 1) {
              if (ts[j]!.value === "#" && ts[j + 1]?.value === "[") {
                const attrEnd = rustGroupEnd(ts, j + 1),
                  attr = ts.slice(j + 2, attrEnd - 1);
                if (["cfg", "cfg_attr"].includes(attr[0]?.value ?? "")) {
                  conditionalVariant = true;
                  if (attr.map((token) => token.value).join("") !== "cfg(test)")
                    issue(
                      module.file,
                      name,
                      "Rust conditional enum variant requires compiler context",
                    );
                }
                j = attrEnd;
                continue;
              }
              if (expectVariant && word(ts[j]!.value)) {
                if (!conditionalVariant) variants.add(ts[j]!.value);
                expectVariant = false;
              }
              if (["{", "(", "["].includes(ts[j]!.value)) j = rustGroupEnd(ts, j);
              else {
                if (ts[j]!.value === ",") {
                  expectVariant = true;
                  conditionalVariant = false;
                }
                j++;
              }
            }
            module.enums.set(name, variants);
            i = end;
            continue;
          }
        }
        // Names in signatures/fields (especially lifetimes) are not module declarations.
        let end = i + 2;
        while (end < ts.length && (ts[end]!.string || !["{", ";"].includes(ts[end]!.value))) {
          if (!ts[end]!.string && ["(", "["].includes(ts[end]!.value)) end = rustGroupEnd(ts, end);
          else end++;
        }
        if (ts[end]?.value === "{") end = rustGroupEnd(ts, end);
        else if (ts[end]?.value === ";") end++;
        parse(ts.slice(i + 2, end), module, chain, false, { bindings: new Map(), parent: scope });
        i = end;
        continue;
      }
      if (value === "{") {
        const end = rustGroupEnd(ts, i);
        parse(ts.slice(i + 1, end - 1), module, chain, false, {
          bindings: new Map(),
          parent: scope,
        });
        i = end;
      } else if (["(", "["].includes(value ?? "")) {
        const end = rustGroupEnd(ts, i);
        parse(ts.slice(i + 1, end - 1), module, chain, false, scope);
        i = end;
      } else i++;
    }
  }
  for (const crate of crates) {
    const modules = crate.roots.map((file) => moduleFor(file, path.posix.dirname(file)));
    roots.set(crate, modules);
    const library = modules.find((module) => module.file === crate.library);
    if (library) libraryRoots.set(crate, library);
    for (const root of modules) {
      const directory = path.posix.dirname(root.file);
      if (
        !focus ||
        (context?.ownManifests.has(crate.manifest) &&
          [...focus].some(
            (file) => file === root.file || directory === "." || file.startsWith(directory + "/"),
          ))
      )
        parseFile(root, new Set());
    }
  }
  function resolve(imported: Use, crate: RustCrate, root: Module) {
    const parts = [...imported.segments],
      first = parts[0];
    let module = imported.module;
    const edition = crate.targetEditions.get(root.file) ?? crate.edition;
    if (first === "crate") {
      module = root;
      parts.shift();
    } else if (first === "self") parts.shift();
    else if (first === "super") {
      while (parts[0] === "super") {
        if (!module.parent) {
          issue(imported.module.file, imported.specifier, "Rust super path escapes the crate root");
          return;
        }
        module = module.parent;
        parts.shift();
      }
    } else {
      for (let scope: Scope | undefined = imported.scope; scope; scope = scope.parent) {
        if (
          [...(scope.bindings.get(first ?? "") ?? [])].some(
            (statement) => statement !== imported.statement,
          )
        ) {
          issue(
            imported.module.file,
            imported.specifier,
            "Rust alias/re-export chain requires symbol resolution",
          );
          return;
        }
      }
      const dep = (
        root.file === crate.buildScript ? crate.buildDependencies : crate.dependencies
      ).get(first ?? "");
      const local =
        edition === "2015"
          ? root.children.has(first ?? "") || root.items.has(first ?? "")
          : !imported.absolute &&
            (module.children.has(first ?? "") || module.items.has(first ?? ""));
      if (local && dep !== undefined) {
        issue(
          imported.module.file,
          imported.specifier,
          "Rust local and dependency names are ambiguous",
        );
        return;
      }
      if (!local) {
        if (["std", "core", "alloc"].includes(first ?? "") || dep === "external") return;
        const ownLibrary =
          root.file !== crate.buildScript && first === crate.libraryName
            ? libraryRoots.get(crate)
            : undefined;
        if (dep && dep !== "unknown") {
          const target = libraryRoots.get(dep);
          if (target) module = target;
          else {
            issue(imported.module.file, imported.specifier, "Local Rust crate root is unavailable");
            return;
          }
        } else if (ownLibrary && ownLibrary !== root) module = ownLibrary;
        else {
          issue(
            imported.module.file,
            imported.specifier,
            dep === "unknown"
              ? "Rust dependency is conditional or its local mapping is unavailable"
              : "Rust import root is unknown or requires alias/re-export resolution",
          );
          return;
        }
        parts.shift();
      } else if (edition === "2015") module = root;
    }
    while (parts.length) {
      const name = parts.shift()!;
      if (!module.loaded && name !== "*") {
        const ancestors = new Set<string>();
        for (let parent = module.parent; parent; parent = parent.parent)
          if (parent.file !== module.file) ancestors.add(parent.file);
        parseFile(module, ancestors);
      }
      if (module.ambiguous.has(name)) {
        issue(
          imported.module.file,
          imported.specifier,
          "Rust import crosses an ambiguous module declaration",
        );
        return;
      }
      if (name === "*" && !parts.length) {
        edge(imported.module.file, module.file, imported.specifier);
        return;
      }
      const child = module.children.get(name);
      if (child) {
        module = child;
        continue;
      }
      if (
        module.items.has(name) &&
        (!parts.length ||
          (parts.length === 1 && (parts[0] === "*" || module.enums.get(name)?.has(parts[0]!))))
      ) {
        edge(imported.module.file, module.file, imported.specifier);
        return;
      }
      issue(
        imported.module.file,
        imported.specifier,
        module.aliases.has(name) || module.aliases.has("*")
          ? "Rust alias/re-export chain requires symbol resolution"
          : "Rust import target is absent or cannot be resolved statically",
      );
      return;
    }
    edge(imported.module.file, module.file, imported.specifier);
  }
  function importsIn(module: Module): Use[] {
    return [...module.imports, ...[...module.children.values()].flatMap(importsIn)];
  }
  for (const [crate, modules] of roots)
    for (const root of modules)
      for (const imported of importsIn(root))
        if (!focus || focus.has(imported.module.file)) resolve(imported, crate, root);
  for (const call of knownMacroCalls) {
    let bound = macroDefinitions.has(call.name);
    for (let scope: Scope | undefined = call.scope; scope; scope = scope.parent)
      bound ||= scope.bindings.has(call.name);
    if (bound)
      issue(call.module.file, call.name, "Rust shadowed macro expansion may contain dependencies");
  }
  for (const file of sources.keys())
    if ((!focus || focus.has(file)) && !visited.has(file) && !testOnly.has(file))
      issue(file, file, "Rust source has no unambiguous Cargo target/module context");
  return { edges, issues, requiredFiles: [...requiredFiles].sort() };
}
