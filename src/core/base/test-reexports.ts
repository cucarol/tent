import path from "node:path";
import type { RepositoryImport, RepositorySource } from "./repository-imports.js";
import { sourceTokens, type SourceToken } from "./source-tokens.js";
import { pythonStatements } from "./python-imports.js";
import { rustTokens, rustGroupEnd, type RustToken } from "./rust-lex.js";

type Forward = { target?: string; name: string; at: number; local?: boolean; rustPath?: string[] };
type Binding = {
  local: string;
  module: string;
  name?: string;
  prefix: string[];
  start: number;
  end: number;
  typeOnly?: boolean;
};
type Model = {
  file: string;
  language: "python" | "script" | "rust";
  tokens: SourceToken[];
  text: string;
  definitions: Map<string, number>;
  publicDefinitions: Set<string>;
  forwards: Map<string, Forward[]>;
  locals: Map<string, Forward[]>;
  stars: Forward[];
  unknown: Set<string>;
  all?: Set<string> | "unknown";
  blocked: boolean;
  bindings: Binding[];
};
export type TestReexportTrace = {
  from: string;
  entry: string;
  name: string;
  useOffset: number;
  definition: string;
  steps: { file: string; name: string; offset: number }[];
};
const word = (value: string | undefined) => /^[A-Za-z_$][\w$]*$/.test(value ?? "");
const posix = path.posix;
const last = <T>(items: readonly T[]) => items[items.length - 1];
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const add = <T>(map: Map<string, T[]>, key: string, value: T) =>
  map.set(key, [...(map.get(key) ?? []), value]);

/** Only value calls/decorators are proved here. Every uncertain occurrence rejects its binding. */
function usedNames(model: Model, binding: Binding) {
  const ts = model.tokens;
  const result = new Map<string, number>();
  const statements = model.language === "python" ? pythonStatements(model.text, ts) : [];
  const typePositions = new Set<number>();
  if (model.language === "script") {
    const braces: boolean[] = [];
    let segment = 0;
    for (let i = 0; i < ts.length; i++) {
      const v = ts[i]!.value;
      if (v === "{") {
        const prefix = ts.slice(segment, i).map((t) => t.value);
        braces.push(
          !!last(braces) ||
            [":", "<"].includes(ts[i - 1]?.value ?? "") ||
            prefix.includes("interface") ||
            prefix.includes("type"),
        );
        segment = i + 1;
      }
      if (last(braces)) typePositions.add(i);
      if (v === "}") {
        braces.pop();
        segment = i + 1;
      }
      if (v === ";") segment = i + 1;
    }
  }
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i]!;
    if (t.kind !== "word" || t.value !== binding.local) continue;
    if (t.start >= binding.start && t.end <= binding.end) continue;
    if (typePositions.has(i)) continue;
    if (ts[i - 1]?.value === "." && ts[i - 2]?.value === ".") return [];
    if (ts[i - 1]?.value === "." || ts[i - 1]?.value === "::") continue;
    // An object key or method name is not a reference to the imported binding.
    if (model.language === "script" && ts[i + 1]?.value === ":") {
      if (["{", ","].includes(ts[i - 1]?.value ?? "")) continue;
      return [];
    }
    if (["function", "class", "def", "fn", "struct", "enum"].includes(ts[i - 1]?.value ?? ""))
      return [];
    const separator = model.language === "rust" ? "::" : ".";
    const members: string[] = [];
    let end = i + 1;
    while (ts[end]?.value === separator && word(ts[end + 1]?.value)) {
      members.push(ts[end + 1]!.value);
      end += 2;
    }
    if (!binding.name && !binding.prefix.every((p, n) => members[n] === p)) return [];
    const name = binding.name ?? members[binding.prefix.length];
    if (!name) return [];
    if (model.language === "python") {
      const statement = statements.find((s) => s.tokens.includes(t));
      const values = statement?.tokens.map((x) => x.value) ?? [];
      const before = statement?.tokens.filter((x) => x.start < t.start).map((x) => x.value) ?? [];
      if (["def", "class", "async"].includes(values[0] ?? "")) return [];
      // Annotations, including future annotations, do not establish a value use.
      if (before.includes(":") && !before.includes("=")) return [];
    }
    if (ts[end]?.value === "(") {
      let depth = 0;
      let close = end;
      for (; close < ts.length; close++) {
        if (ts[close]!.kind !== "symbol") continue;
        if (ts[close]!.value === "(") depth++;
        if (ts[close]!.value === ")" && --depth === 0) break;
      }
      if (close === ts.length) return [];
      if (model.language === "script" && ["{", ":"].includes(ts[close + 1]?.value ?? "")) {
        if (["{", ",", ";"].includes(ts[i - 1]?.value ?? "")) continue;
        return [];
      }
      result.set(name, t.start);
    } else if (model.language === "python" && ts[i - 1]?.value === "@") {
      result.set(name, t.start);
    } else return [];
  }
  return [...result].map(([name, offset]) => ({ name, offset }));
}

/** Supplemental test evidence only. Existing direct edges are immutable anchors. */
export function traceTestReexports(
  input: readonly RepositorySource[],
  direct: readonly RepositoryImport[],
  isTest: (file: string) => boolean,
) {
  const files = new Map(input.map((file) => [file.path, file]));
  const models = new Map<string, Model>();
  function pythonFile(from: string, specifier: string) {
    const level = /^\.+/.exec(specifier)?.[0].length ?? 0;
    let directory = posix.dirname(from);
    for (let n = 1; n < level; n++) directory = posix.dirname(directory);
    const name = specifier.slice(level).replace(/\./g, "/");
    const stems = level
      ? [posix.join(directory, name)]
      : [name, posix.join("src", name), posix.join("lib", name)];
    return stems
      .flatMap((stem) => [stem + ".py", posix.join(stem, "__init__.py")])
      .find((file) => !file.startsWith("../") && files.has(file));
  }
  function scriptFile(from: string, specifier: string) {
    if (!specifier.startsWith(".")) return;
    const target = posix.join(posix.dirname(from), specifier);
    const stems = [
      ...new Set([
        target,
        target.replace(/\.js$/, ".ts"),
        target.replace(/\.js$/, ".tsx"),
        target.replace(/\.mjs$/, ".mts"),
        target.replace(/\.cjs$/, ".cts"),
      ]),
    ];
    return stems
      .flatMap((stem) =>
        [
          "",
          ".ts",
          ".tsx",
          ".d.ts",
          ".mts",
          ".cts",
          ".js",
          ".jsx",
          ".mjs",
          ".cjs",
          "/index.ts",
          "/index.tsx",
          "/index.d.ts",
          "/index.js",
          "/index.mjs",
        ].map((suffix) => stem + suffix),
      )
      .find((file) => !file.startsWith("../") && files.has(file));
  }
  function definition(model: Model, name: string, offset: number, exported = true) {
    if (model.definitions.has(name) || model.forwards.has(name) || model.locals.has(name))
      model.unknown.add(name);
    model.definitions.set(name, offset);
    if (exported) model.publicDefinitions.add(name);
  }
  function python(model: Model, text: string) {
    let decorated = false;
    for (const s of pythonStatements(text, model.tokens)) {
      const ts = s.tokens;
      const values = ts.map((t) => t.value);
      const first = values[0];
      const top = s.indent === 0;
      const at = ts[0]!.start;
      if (top && first === "@") {
        decorated = true;
        continue;
      }
      const declared = first === "async" ? values[2] : values[1];
      if (
        ts[0]?.kind === "word" &&
        (["def", "class"].includes(first ?? "") || (first === "async" && values[1] === "def"))
      ) {
        if (declared) {
          if (top) {
            definition(model, declared, at);
            if (decorated) model.unknown.add(declared);
          } else model.unknown.add(declared);
          if (declared === "__getattr__") model.blocked = true;
        }
      }
      if (top) decorated = false;
      if (
        values.some(
          (v, i) =>
            ["exec", "eval", "globals", "locals", "vars", "setattr"].includes(v) &&
            values[i + 1] === "(",
        )
      )
        model.blocked = true;
      if (
        values.includes("__dict__") ||
        (values.includes("modules") && values.includes("=")) ||
        (first === "__path__" && values.includes("="))
      )
        model.blocked = true;
      if (first === "del") for (const name of values.slice(1).filter(word)) model.unknown.add(name);
      const bindingStart = first === "async" ? 1 : 0;
      if (values[bindingStart] === "for") {
        const stop = values.indexOf("in", bindingStart + 1);
        for (const name of values.slice(bindingStart + 1, stop < 0 ? undefined : stop).filter(word))
          model.unknown.add(name);
      }
      if (["with", "except", "except*"].includes(values[bindingStart] ?? "")) {
        for (let i = bindingStart + 1; i < values.length; i++)
          if (values[i] === "as") {
            for (const name of values.slice(i + 1).filter(word)) model.unknown.add(name);
          }
      }
      if (first === "global")
        for (const name of values.slice(1).filter(word)) model.unknown.add(name);
      if (first === "__all__") {
        const literal =
          top &&
          values[1] === "=" &&
          ["[", "("].includes(values[2] ?? "") &&
          ["]", ")"].includes(last(values) ?? "") &&
          ts.slice(3, -1).every((t) => t.kind === "string" || t.value === ",");
        if (model.all !== undefined || !literal) model.all = "unknown";
        else
          model.all = new Set(
            ts
              .slice(3, -1)
              .filter((t) => t.kind === "string")
              .map((t) => t.value),
          );
      }
      if (first === "case")
        for (const name of values.slice(1, values.indexOf(":")).filter(word))
          model.unknown.add(name);
      const assigned = values.findIndex(
        (v, i) => v === "=" && values[i - 1] !== "=" && values[i + 1] !== "=",
      );
      if (assigned > 0 && first !== "__all__")
        for (const name of values.slice(0, assigned).filter(word)) model.unknown.add(name);
      const imported = values.indexOf("import");
      if (ts[0]?.kind !== "word" || !(first === "import" || (first === "from" && imported > 0)))
        continue;
      const module = first === "from" ? values.slice(1, imported).join("") : undefined;
      const groups: SourceToken[][] = [[]];
      for (const t of ts.slice(imported + 1)) {
        if (["(", ")", "\\"].includes(t.value)) continue;
        if (t.value === ",") groups.push([]);
        else last(groups)!.push(t as SourceToken);
      }
      for (const group of groups.filter((g) => g.length)) {
        const alias = group.findIndex((t) => t.value === "as");
        const name = group
          .slice(0, alias < 0 ? undefined : alias)
          .map((t) => t.value)
          .join("");
        const specifier = module ?? name;
        const local = alias < 0 ? (module ? name : name.split(".")[0]!) : group[alias + 1]?.value;
        if (!local) continue;
        const target = pythonFile(model.file, specifier);
        if (name === "*" && module) {
          if (top) model.stars.push({ target, name: "*", at });
          else model.blocked = true;
        } else if (module) {
          if (model.definitions.has(local)) model.unknown.add(local);
          add(model.forwards, local, { target, name, at });
          if (!top) model.unknown.add(local);
        } else model.unknown.add(local);
        if (top && name !== "*")
          model.bindings.push({
            local,
            module: specifier,
            name: module ? name : undefined,
            prefix: !module && alias < 0 ? name.split(".").slice(1) : [],
            start: at,
            end: last(ts)!.end,
          });
      }
    }
    // Assignments/deletes to a declared module name can defeat a unique static definition.
    for (let i = 0; i < model.tokens.length; i++) {
      const t = model.tokens[i]!;
      if (model.definitions.has(t.value) && ["=", ":="].includes(model.tokens[i + 1]?.value ?? ""))
        model.unknown.add(t.value);
    }
  }
  function script(model: Model) {
    const ts = model.tokens;
    for (let i = 0; i < ts.length;) {
      const begin = i;
      if (ts[i]?.value === "@") {
        model.blocked = true;
        return;
      }
      let exported = false,
        defaultExport = false,
        typeOnly = false;
      if (ts[i]?.kind === "word" && ts[i]?.value === "export") {
        exported = true;
        i++;
        if (ts[i]?.value === "default") {
          defaultExport = true;
          i++;
        }
        if (ts[i]?.value === "type") {
          typeOnly = true;
          i++;
        }
      }
      const value = ts[i]?.value;
      if (
        (ts[i]?.kind === "word" && value === "import") ||
        (exported && ["{", "*"].includes(value ?? ""))
      ) {
        const importing = value === "import";
        let end = i + 1,
          depth = value === "{" ? 1 : 0;
        while (end < ts.length) {
          const v = ts[end]!.value;
          if (
            ts[end]!.kind === "string" &&
            (ts[end - 1]?.value === "from" || (importing && end === i + 1))
          )
            break;
          if (v === "{") depth++;
          if (v === "}") depth--;
          if (
            (v === ";" && depth === 0) ||
            (exported && depth === 0 && v === "}" && ts[end + 1]?.value !== "from")
          )
            break;
          end++;
        }
        const spec = ts[end]?.kind === "string" ? ts[end]!.value : undefined;
        const target = spec ? scriptFile(model.file, spec) : undefined;
        const content = ts.slice(i + (importing ? 1 : 0), spec ? end : end + 1);
        typeOnly ||= content[0]?.value === "type";
        const open = content.findIndex((t) => t.value === "{");
        const close = content.findIndex((t) => t.value === "}");
        const at = ts[begin]!.start;
        if (content.some((t) => t.value === "*") && !importing) {
          const as = content.findIndex((t) => t.value === "as");
          if (!typeOnly && as < 0) model.stars.push({ target, name: "*", at });
          else if (as >= 0) model.unknown.add(content[as + 1]?.value ?? "");
        } else if (open >= 0 && close > open) {
          const groups: SourceToken[][] = [[]];
          for (const t of content.slice(open + 1, close)) {
            if (t.value === ",") groups.push([]);
            else last(groups)!.push(t);
          }
          for (const group of groups.filter((g) => g.length)) {
            const groupType = typeOnly || group[0]?.value === "type";
            const words = group.filter((t) => t.value !== "type");
            const name = words[0]?.value;
            const as = words.findIndex((t) => t.value === "as");
            const local = as < 0 ? name : words[as + 1]?.value;
            if (!name || !local) continue;
            if (importing) {
              if (model.definitions.has(local)) model.unknown.add(local);
              add(model.locals, local, { target, name, at });
              if (groupType) model.unknown.add(local);
              model.bindings.push({
                local,
                module: spec ?? "",
                name,
                prefix: [],
                start: at,
                end: ts[end]!.end,
                typeOnly: groupType,
              });
            } else if (groupType) model.unknown.add(local);
            else
              add(model.forwards, local, {
                target: spec ? target : model.file,
                name,
                at,
                local: !spec,
              });
          }
        } else if (importing) {
          const star = content.findIndex((t) => t.value === "*");
          const named = content.find((t) => t.kind === "word" && t.value !== "type");
          if (star >= 0) {
            const local = content[star + 2]?.value;
            if (local)
              model.bindings.push({
                local,
                module: spec ?? "",
                prefix: [],
                start: at,
                end: ts[end]!.end,
                typeOnly,
              });
          } else if (named)
            model.bindings.push({
              local: named.value,
              module: spec ?? "",
              name: "default",
              prefix: [],
              start: at,
              end: ts[end]!.end,
              typeOnly,
            });
        }
        i = Math.min(end + 1, ts.length);
        if (ts[i]?.value === ";") i++;
        continue;
      }
      if (value === "async") i++;
      if (
        ts[i]?.kind === "word" &&
        ["function", "class", "const", "let", "var"].includes(ts[i]?.value ?? "")
      ) {
        const kind = ts[i]!.value;
        const name = ts[i + 1]?.value;
        if (word(name) && ts[i + 1]?.kind === "word") {
          const key = defaultExport ? "default" : name!;
          if (["let", "var"].includes(kind)) model.unknown.add(key);
          else definition(model, key, ts[i]!.start, exported);
        } else if (defaultExport && kind === "function") definition(model, "default", ts[i]!.start);
        else if (exported) model.blocked = true;
      } else if (exported && (typeOnly || ts[i]?.value === "interface")) {
        model.unknown.add(typeOnly ? (ts[i]?.value ?? "") : (ts[i + 1]?.value ?? ""));
      } else if (exported) model.blocked = true;
      // Advance one whole top-level statement/item, leaving bodies opaque for export discovery.
      let depth = 0;
      for (i = Math.max(i, begin); i < ts.length; i++) {
        const v = ts[i]!.value;
        if (["{", "(", "["].includes(v)) depth++;
        if (["}", ")", "]"].includes(v)) depth--;
        if (depth === 0 && (v === ";" || v === "}")) {
          i++;
          break;
        }
        if (depth === 0 && i > begin && ts[i]!.kind === "word" && ["export", "import"].includes(v))
          break;
      }
    }
    for (let i = 0; i < ts.length; i++) {
      if (["eval", "with"].includes(ts[i]!.value) && ts[i + 1]?.value === "(") model.blocked = true;
      if (["exports", "module"].includes(ts[i]!.value) && ts[i + 1]?.value === ".")
        model.blocked = true;
      if (ts[i]!.value === "exports") model.blocked = true;
      if (
        model.definitions.has(ts[i]!.value) &&
        ts[i - 1]?.value !== "." &&
        ["=", "+", "-"].includes(ts[i + 1]?.value ?? "") &&
        !["const", "function", "class"].includes(ts[i - 1]?.value ?? "")
      )
        model.unknown.add(ts[i]!.value);
      if (ts[i]!.value === "=" && ["]", "}"].includes(ts[i - 1]?.value ?? "")) {
        const close = ts[i - 1]!.value,
          open = close === "]" ? "[" : "{";
        let depth = 1;
        for (let j = i - 2; j >= 0 && depth; j--) {
          if (ts[j]!.value === close) depth++;
          if (ts[j]!.value === open) depth--;
          if (model.definitions.has(ts[j]!.value)) model.unknown.add(ts[j]!.value);
        }
      }
    }
  }
  const rustParents = new Map<string, string>();
  const rustRoots = new Map<string, string>();
  const rustChildren = new Map<string, Map<string, string>>();
  function rustModuleFile(from: string, name: string) {
    const stem =
      posix.basename(from) === "lib.rs" || posix.basename(from) === "mod.rs"
        ? posix.dirname(from)
        : from.slice(0, -3);
    return [posix.join(stem, name + ".rs"), posix.join(stem, name, "mod.rs")].find((file) =>
      files.has(file),
    );
  }
  function rustForward(from: string, parts: string[]): Forward {
    parts = [...parts];
    let current = from;
    if (parts[0] === "crate") {
      current = rustRoots.get(from) ?? from;
      parts.shift();
    } else if (parts[0] === "self") parts.shift();
    while (parts[0] === "super") {
      current = rustParents.get(current) ?? "";
      parts.shift();
    }
    while (current && parts.length > 1) {
      const model = get(current);
      const child =
        model && !model.blocked ? rustChildren.get(current)?.get(parts.shift()!) : undefined;
      if (!child) {
        current = "";
        break;
      }
      rustParents.set(child, current);
      rustRoots.set(child, rustRoots.get(current) ?? current);
      current = child;
    }
    return { target: current || undefined, name: parts[0] ?? "", at: 0 };
  }
  function useTree(ts: readonly RustToken[]) {
    let i = 0;
    const out: { parts: string[]; alias?: string }[] = [];
    function tree(prefix: string[]) {
      const parts = [...prefix];
      while (i < ts.length) {
        const v = ts[i++]!.value;
        if (v === "::") continue;
        if (v === "{") {
          while (i < ts.length && ts[i]?.value !== "}") {
            tree(parts);
            if (ts[i]?.value === ",") i++;
            else if (ts[i]?.value !== "}") break;
          }
          i++;
          return;
        }
        if (!word(v) && v !== "*") return;
        parts.push(v);
        if (ts[i]?.value === "::") {
          i++;
          continue;
        }
        let alias: string | undefined;
        if (ts[i]?.value === "as") {
          i++;
          alias = ts[i++]?.value;
        }
        out.push({ parts: last(parts) === "self" ? parts.slice(0, -1) : parts, alias });
        return;
      }
    }
    tree([]);
    return out;
  }
  function rust(model: Model, text: string) {
    const ts = rustTokens(text);
    // Offsets are reconstructed from the shared lexer solely for proved value references.
    for (let i = 0; i < ts.length;) {
      const start = i;
      if (ts[i]?.value === "#") {
        if (isTest(model.file) && ts[i + 1]?.value === "[") {
          const end = rustGroupEnd(ts, i + 1);
          if (
            ts
              .slice(i + 2, end - 1)
              .map((t) => t.value)
              .join("") === "test"
          ) {
            i = end;
            continue;
          }
        }
        // Keep the existing Core compiler/attribute stopping line; never reinterpret cfg_attr.
        model.blocked = true;
        return;
      }
      let exported = false;
      if (ts[i]?.value === "pub") {
        exported = true;
        i++;
      }
      if (ts[i]?.value === "(") {
        model.blocked = true;
        return;
      }
      if (ts[i]?.value === "use") {
        const begin = ++i;
        while (i < ts.length && ts[i]?.value !== ";") i++;
        for (const item of useTree(ts.slice(begin, i))) {
          const name = item.alias ?? last(item.parts)!;
          if (exported) {
            const forward: Forward = {
              name: item.parts[item.parts.length - 1]!,
              at: 0,
              rustPath: item.parts,
            };
            if (name === "*") model.stars.push(forward);
            else add(model.forwards, name, forward);
          }
        }
        i++;
        continue;
      }
      if (ts[i]?.value === "mod" && word(ts[i + 1]?.value)) {
        const child = rustModuleFile(model.file, ts[i + 1]!.value);
        if (ts[i + 2]?.value !== ";" || !child) {
          model.blocked = true;
          return;
        }
        rustParents.set(child, model.file);
        rustRoots.set(child, rustRoots.get(model.file) ?? model.file);
        const children = rustChildren.get(model.file) ?? new Map<string, string>();
        children.set(ts[i + 1]!.value, child);
        rustChildren.set(model.file, children);
      }
      if (
        exported &&
        ["fn", "struct", "enum", "trait", "const", "static"].includes(ts[i]?.value ?? "") &&
        word(ts[i + 1]?.value)
      )
        definition(model, ts[i + 1]!.value, 0);
      // Macro expansion may introduce or overwrite an exported binding.
      if (ts.slice(start, i + 2).some((t) => t.value === "!")) {
        model.blocked = true;
        return;
      }
      while (i < ts.length && !["{", ";"].includes(ts[i]!.value)) i++;
      if (ts[i]?.value === "{") i = rustGroupEnd(ts, i);
      else i++;
    }
  }
  function get(file: string): Model | undefined {
    if (models.has(file)) return models.get(file);
    const source = files.get(file);
    if (
      source?.content === undefined ||
      !/\.(?:py|rs|[cm]?[jt]sx?)$/.test(file) ||
      /\.d\.[cm]?ts$/.test(file)
    )
      return;
    const language = file.endsWith(".py") ? "python" : file.endsWith(".rs") ? "rust" : "script";
    const model: Model = {
      file,
      language,
      tokens: sourceTokens(source.content, language === "python"),
      text: source.content,
      definitions: new Map(),
      publicDefinitions: new Set(),
      forwards: new Map(),
      locals: new Map(),
      stars: [],
      unknown: new Set(),
      blocked: false,
      bindings: [],
    };
    models.set(file, model);
    if (language === "rust") {
      const combined: SourceToken[] = [];
      for (let i = 0; i < model.tokens.length; i++) {
        const t = model.tokens[i]!;
        if (
          t.value === ":" &&
          model.tokens[i + 1]?.value === ":" &&
          t.end === model.tokens[i + 1]!.start
        ) {
          combined.push({ ...t, value: "::", end: model.tokens[++i]!.end });
        } else combined.push(t);
      }
      model.tokens = combined;
      // The shared script lexer does not model Rust lifetimes. Such files stay at their anchors.
      if (source.content.includes("'")) model.blocked = true;
    }
    if (language === "python") python(model, source.content);
    else if (language === "script") script(model);
    else rust(model, source.content);
    return model;
  }
  type State = { file: string; name: string; local?: boolean };
  const key = (s: State) => JSON.stringify([s.file, s.name, !!s.local]);
  function successors(s: State) {
    if (isTest(s.file)) return { next: [], blocked: true, at: undefined };
    const model = get(s.file);
    const next: { state: State; offset: number }[] = [];
    let blocked = !model || model.blocked || model.unknown.has(s.name);
    let at: number | undefined;
    if (model && !blocked) {
      if ((s.local || model.publicDefinitions.has(s.name)) && model.definitions.has(s.name))
        at = model.definitions.get(s.name);
      const forwards = (s.local ? model.locals : model.forwards).get(s.name) ?? [];
      for (const original of forwards) {
        const f = original.rustPath ? rustForward(model.file, original.rustPath) : original;
        if (!f.target) blocked = true;
        else next.push({ state: { file: f.target, name: f.name, local: f.local }, offset: f.at });
      }
      if (!s.local)
        for (const original of model.language === "script" && (forwards.length || at !== undefined)
          ? []
          : model.stars) {
          const f = original.rustPath ? rustForward(model.file, original.rustPath) : original;
          if (!f.target) {
            blocked = true;
            continue;
          }
          const target = get(f.target);
          if (model.language === "python") {
            if (target?.all === "unknown") {
              blocked = true;
              continue;
            }
            if (target?.all instanceof Set && !target.all.has(s.name)) continue;
            if (!target?.all && s.name.startsWith("_")) continue;
          }
          next.push({ state: { file: f.target, name: s.name }, offset: f.at });
        }
    }
    return { next, blocked, at };
  }
  // Iterative traversal: no fixed depth limit and no call-stack limit on long export chains.
  function resolve(start: State) {
    const seen = new Set<string>(),
      active = new Set<string>();
    type Trail = { step: TestReexportTrace["steps"][number]; parent?: Trail };
    const stack: { state: State; leave: boolean; trail?: Trail }[] = [
      { state: start, leave: false },
    ];
    const definitions = new Map<string, { file: string; steps: TestReexportTrace["steps"] }>();
    while (stack.length) {
      const frame = stack.pop()!,
        id = key(frame.state);
      if (frame.leave) {
        active.delete(id);
        seen.add(id);
        continue;
      }
      if (active.has(id)) return;
      if (seen.has(id)) continue;
      const result = successors(frame.state);
      if (result.blocked) return;
      active.add(id);
      stack.push({ ...frame, leave: true });
      if (result.at !== undefined) {
        const steps: TestReexportTrace["steps"] = [
          { file: frame.state.file, name: frame.state.name, offset: result.at },
        ];
        for (let trail = frame.trail; trail; trail = trail.parent) steps.push(trail.step);
        steps.reverse();
        definitions.set(frame.state.file + "\0" + frame.state.name, {
          file: frame.state.file,
          steps,
        });
        if (definitions.size > 1) return;
      }
      for (const n of result.next)
        stack.push({
          state: n.state,
          leave: false,
          trail: {
            step: { file: frame.state.file, name: frame.state.name, offset: n.offset },
            parent: frame.trail,
          },
        });
    }
    return definitions.size === 1 ? [...definitions.values()][0] : undefined;
  }
  const traces: TestReexportTrace[] = [],
    edges: RepositoryImport[] = [];
  for (const from of [...new Set(direct.map((edge) => edge.from))].sort()) {
    const model = get(from);
    if (!model || model.blocked) continue;
    if (model.language === "rust") {
      // Named alias chains unresolved by Core have no anchor; namespace imports can retain one.
      const ts = model.tokens;
      for (let i = 0; i < ts.length; i++)
        if (ts[i]?.value === "use") {
          let end = i + 1;
          while (end < ts.length && ts[end]?.value !== ";") end++;
          const values = ts.slice(i + 1, end).map((t) => ({ value: t.value }));
          for (const u of useTree(values)) {
            if (u.parts.length !== 1 || u.parts[0] === "*") continue;
            model.bindings.push({
              local: u.alias ?? u.parts[0]!,
              module: u.parts[0]!,
              prefix: [],
              start: ts[i]!.start,
              end: ts[end]?.end ?? last(ts)!.end,
            });
          }
          i = end;
        }
    }
    for (const binding of model.bindings) {
      if (binding.typeOnly || model.bindings.filter((b) => b.local === binding.local).length !== 1)
        continue;
      const anchors = direct.filter(
        (edge) =>
          edge.from === from &&
          edge.kind === "file" &&
          edge.specifier === binding.module &&
          edge.execution !== "type-only",
      );
      for (const anchor of anchors) {
        for (const use of usedNames(model, binding)) {
          const resolved = resolve({ file: anchor.to, name: use.name });
          if (
            !resolved ||
            isTest(resolved.file) ||
            resolved.file === anchor.to ||
            resolved.steps.length < 2
          )
            continue;
          traces.push({
            from,
            entry: anchor.to,
            name: use.name,
            useOffset: use.offset,
            definition: resolved.file,
            steps: resolved.steps,
          });
          edges.push({ ...anchor, to: resolved.file });
        }
      }
    }
  }
  return {
    edges: [...new Map(edges.map((edge) => [JSON.stringify(edge), edge])).values()].sort((a, b) =>
      order(JSON.stringify(a), JSON.stringify(b)),
    ),
    traces: traces.sort((a, b) => order(JSON.stringify(a), JSON.stringify(b))),
  };
}
