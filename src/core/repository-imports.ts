import path from "node:path";

/** Workspace-relative POSIX paths. Omit content for files that need no parsing. */
export type RepositorySource = { path: string; content?: string };
/** Go imports target packages; other supported imports target actual files. */
export type RepositoryImport = {
  from: string;
  to: string;
  kind: "file" | "directory";
  specifier: string;
};
export type RepositoryImportIssue = { file: string; specifier?: string; reason: string };

export const comparePaths = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const isTestSource = (file: string) =>
  /(^|\/)(tests?|__tests__|spec|testdata|fixtures)\/|(^|\/)test_[^/]+\.py$|[._-](test|spec)\.[^/]+$|_test\.go$/.test(
    file,
  );
export const isCodeSource = (file: string) =>
  /\.(go|[cm]?[jt]sx?|py|rs|java|kt|swift|rb|php|cs|c|cc|cpp|h|hpp|vue|svelte)$/.test(file);
export const isGeneratedSource = (file: string) =>
  /(^|\/)(gen|generated|__generated__)\/|\.pb\.go$|_pb\.ts$|\.pb\.ts$|\.g\.dart$/.test(file);
export const isImportSource = (file: string) => /\.(go|[cm]?[jt]sx?|py)$/.test(file);
export const isImportConfig = (file: string) => /(^|\/)(go\.mod|tsconfig[^/]*\.json)$/.test(file);

type Token = { value: string; kind: "word" | "string" | "symbol"; start: number; end: number };

/** Small lexical pass: quoted examples and comments never become import statements. */
function tokens(text: string, python = false, go = false): Token[] {
  const result: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const start = i,
      c = text[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if ((python && c === "#") || (!python && text.startsWith("//", i))) {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (!python && text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (
      !python &&
      !go &&
      c === "/" &&
      (!result.length ||
        ["=", "(", "[", ",", ":", ";", "!", "?", "return", "=>"].includes(
          result[result.length - 1]!.value,
        ))
    ) {
      i++;
      let characterClass = false;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === "[") characterClass = true;
        if (text[i] === "]") characterClass = false;
        if (text[i++] === "/" && !characterClass) break;
      }
      while (/[a-z]/i.test(text[i] ?? "")) i++;
      result.push({ value: "", kind: "string", start, end: i });
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const triple = python && text.startsWith(c.repeat(3), i);
      const delimiter = triple ? c.repeat(3) : c;
      i += delimiter.length;
      const contentStart = i;
      while (i < text.length && !text.startsWith(delimiter, i)) {
        if (text[i] === "\\") i += 2;
        else i++;
      }
      const value = text.slice(contentStart, i);
      i = Math.min(text.length, i + delimiter.length);
      // Template literals/docstrings are opaque; they cannot name static imports.
      result.push({
        value: triple || (c === "`" && !go) ? "" : value,
        kind: "string",
        start,
        end: i,
      });
      continue;
    }
    if (/[\w$]/.test(c)) {
      while (i < text.length && /[\w$]/.test(text[i]!)) i++;
      result.push({ value: text.slice(start, i), kind: "word", start, end: i });
      continue;
    }
    result.push({ value: c, kind: "symbol", start, end: ++i });
  }
  return result;
}

function scriptImports(text: string): string[] {
  const ts = tokens(text),
    imports: string[] = [];
  for (let i = 0; i < ts.length; i++) {
    const token = ts[i]!;
    if (token.kind !== "word" || ts[i - 1]?.value === ".") continue;
    if (token.value === "require" || token.value === "import") {
      if (ts[i + 1]?.value === "(" && ts[i + 2]?.kind === "string" && ts[i + 3]?.value === ")")
        imports.push(ts[i + 2]!.value);
      if (token.value === "import" && ts[i + 1]?.kind === "string") imports.push(ts[i + 1]!.value);
    }
    if (!["import", "export"].includes(token.value) || ts[i + 1]?.value === "(") continue;
    for (let j = i + 1; j < ts.length; j++) {
      const next = ts[j]!;
      if (next.value === ";" || (next.kind === "word" && ["import", "export"].includes(next.value)))
        break;
      if (next.value === "from" && ts[j + 1]?.kind === "string") {
        imports.push(ts[j + 1]!.value);
        break;
      }
      // An export declaration with a body is not a re-export.
      if (next.value === "=" || ["function", "class", "const", "let", "var"].includes(next.value))
        break;
    }
  }
  return imports;
}

function goImports(text: string): string[] {
  const ts = tokens(text, false, true),
    imports: string[] = [];
  for (let i = 0; i < ts.length; i++) {
    if (ts[i]!.kind !== "word" || ts[i]!.value !== "import") continue;
    if (ts[i + 1]?.value === "(") {
      for (let j = i + 2; j < ts.length && ts[j]!.value !== ")"; j++)
        if (ts[j]!.kind === "string") imports.push(ts[j]!.value);
    } else {
      const target = ts[i + 1]?.kind === "string" ? ts[i + 1] : ts[i + 2];
      if (target?.kind === "string") imports.push(target.value);
    }
  }
  return imports;
}

function pythonImports(text: string): Array<{ module: string; names: string[] }> {
  // Preserve newlines but mask strings/comments so only real statements match.
  const ts = tokens(text, true);
  let masked = "",
    cursor = 0;
  for (const token of ts) {
    masked += text.slice(cursor, token.start).replace(/[^\r\n]/g, " ");
    masked +=
      token.kind === "string"
        ? text.slice(token.start, token.end).replace(/[^\r\n]/g, " ")
        : token.value;
    cursor = token.end;
  }
  masked += text.slice(cursor).replace(/[^\r\n]/g, " ");
  const result: Array<{ module: string; names: string[] }> = [];
  for (const match of masked.matchAll(
    /(?:^|[;\n])\s*(?:from\s+([\w.]+)\s+import\s+(\([^)]*\)|[^;\n]+)|import\s+([^;\n]+))/g,
  )) {
    if (match[1]) {
      result.push({
        module: match[1],
        names: (match[2] ?? "")
          .replace(/[()]/g, "")
          .split(",")
          .map((part) => part.trim().split(/\s+/)[0]!)
          .filter(Boolean),
      });
    } else {
      for (const part of (match[3] ?? "").split(",")) {
        const module = part.trim().split(/\s+/)[0];
        if (module) result.push({ module, names: [] });
      }
    }
  }
  return result;
}

function jsonConfig(text: string): unknown {
  const ts = tokens(text);
  let clean = "",
    cursor = 0;
  for (let i = 0; i < ts.length; i++) {
    const token = ts[i]!;
    clean += text.slice(cursor, token.start).replace(/[^\r\n]/g, " ");
    if (!(
      token.value === "," &&
      token.kind === "symbol" &&
      ["}", "]"].includes(ts[i + 1]?.value ?? "")
    ))
      clean += text.slice(token.start, token.end);
    cursor = token.end;
  }
  return JSON.parse(clean);
}

const inWorkspace = (file: string) =>
  file !== ".." && !file.startsWith("../") && !path.posix.isAbsolute(file);
const ordered = (items: Iterable<string>) => [...new Set(items)].sort(comparePaths);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Pure, deterministic, local imports only; no disk, Git, model or package resolution. */
export function extractRepositoryImports(input: readonly RepositorySource[]) {
  const files = [...input].sort((a, b) => comparePaths(a.path, b.path));
  const byPath = new Map(files.map((file) => [file.path, file]));
  const production = files.filter((file) => isImportSource(file.path) && !isTestSource(file.path));
  const productionPaths = new Set(production.map((file) => file.path));
  const goPackageDirectories = new Set(
    production
      .filter((file) => file.path.endsWith(".go"))
      .map((file) => path.posix.dirname(file.path)),
  );
  const issues: RepositoryImportIssue[] = [];
  const configs = new Map<string, { base: string; paths: Record<string, string[]> }>();
  const modules = files
    .filter((file) => /(^|\/)go\.mod$/.test(file.path))
    .flatMap((file) => {
      const module = /^\s*module\s+(?:"([^\"]+)"|(\S+))/m.exec(file.content ?? "");
      return module
        ? [{ directory: path.posix.dirname(file.path), module: module[1] ?? module[2]! }]
        : [];
    })
    .sort(
      (a, b) => b.directory.length - a.directory.length || comparePaths(a.directory, b.directory),
    );
  for (const file of files.filter((file) => /(^|\/)tsconfig[^/]*\.json$/.test(file.path))) {
    if (file.content === undefined) continue;
    try {
      const json = jsonConfig(file.content);
      const options =
        isRecord(json) && json.compilerOptions !== undefined ? json.compilerOptions : {};
      const paths = isRecord(options) && options.paths !== undefined ? options.paths : {};
      if (
        !isRecord(json) ||
        !isRecord(options) ||
        (options.baseUrl !== undefined && typeof options.baseUrl !== "string") ||
        !isRecord(paths) ||
        Object.values(paths).some(
          (mappings) =>
            !Array.isArray(mappings) || mappings.some((mapping) => typeof mapping !== "string"),
        )
      ) {
        issues.push({ file: file.path, reason: "Invalid TypeScript path configuration" });
        continue;
      }
      configs.set(file.path, {
        base: path.posix.join(path.posix.dirname(file.path), options.baseUrl ?? "."),
        paths: paths as Record<string, string[]>,
      });
    } catch {
      issues.push({ file: file.path, reason: "Cannot parse TypeScript path configuration" });
    }
  }
  const tsExtensions = [
    "",
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".json",
    "/index.ts",
    "/index.tsx",
    "/index.js",
    "/index.mjs",
  ];
  function resolveScript(from: string, specifier: string): string | undefined {
    const targets: string[] = [];
    if (specifier.startsWith("."))
      targets.push(path.posix.join(path.posix.dirname(from), specifier));
    else {
      const applicable = [...configs]
        .filter(([file]) => {
          const dir = path.posix.dirname(file);
          return dir === "." || from.startsWith(dir + "/");
        })
        .sort(([a], [b]) => b.split("/").length - a.split("/").length || comparePaths(a, b));
      for (const [, config] of applicable) {
        const matches = Object.entries(config.paths)
          .filter(([key]) => {
            const star = key.indexOf("*");
            return star < 0
              ? key === specifier
              : specifier.startsWith(key.slice(0, star)) && specifier.endsWith(key.slice(star + 1));
          })
          .sort(
            ([a], [b]) =>
              b.replace("*", "").length - a.replace("*", "").length || comparePaths(a, b),
          );
        if (!matches.length) continue;
        const [key, mappings] = matches[0]!;
        const star = key.indexOf("*");
        const matched =
          star < 0 ? "" : specifier.slice(star, specifier.length - (key.length - star - 1));
        for (const mapping of mappings)
          targets.push(path.posix.join(config.base, mapping.replace("*", matched)));
        break;
      }
    }
    for (const target of targets) {
      if (!inWorkspace(target)) continue;
      const stems = [
        ...new Set(
          [target, target.replace(/[?#].*$/, "")].flatMap((plain) => [
            plain,
            plain.replace(/\.js$/, ".ts"),
            plain.replace(/\.js$/, ".tsx"),
            plain.replace(/\.mjs$/, ".mts"),
            plain.replace(/\.cjs$/, ".cts"),
          ]),
        ),
      ];
      for (const stem of stems)
        for (const extension of tsExtensions) {
          const candidate = stem + extension;
          if (byPath.has(candidate)) return candidate;
        }
    }
    return undefined;
  }
  const edges: RepositoryImport[] = [];
  const add = (from: string, to: string, kind: RepositoryImport["kind"], specifier: string) => {
    if (from !== to && !isTestSource(to)) edges.push({ from, to, kind, specifier });
  };
  const pythonFile = (target: string) => {
    if (!inWorkspace(target)) return;
    return [target + ".py", path.posix.join(target, "__init__.py")].find((file) =>
      productionPaths.has(file),
    );
  };
  for (const file of production) {
    if (file.content === undefined) continue;
    if (file.path.endsWith(".go")) {
      const module = modules.find(
        (mod) => mod.directory === "." || file.path.startsWith(mod.directory + "/"),
      );
      if (!module) continue;
      for (const specifier of goImports(file.content)) {
        if (specifier !== module.module && !specifier.startsWith(module.module + "/")) continue;
        const target = path.posix.join(
          module.directory,
          specifier.slice(module.module.length).replace(/^\//, ""),
        );
        if (goPackageDirectories.has(target)) add(file.path, target, "directory", specifier);
        else
          issues.push({
            file: file.path,
            specifier,
            reason: "Local Go package is absent from production files",
          });
      }
    } else if (file.path.endsWith(".py")) {
      for (const imported of pythonImports(file.content)) {
        const level = /^\.+/.exec(imported.module)?.[0].length ?? 0;
        const name = imported.module.slice(level).replace(/\./g, "/");
        let base = path.posix.dirname(file.path);
        for (let n = 1; n < level; n++) base = path.posix.dirname(base);
        const targets = level
          ? [path.posix.join(base, name)]
          : [name, path.posix.join("src", name), path.posix.join("lib", name)];
        let found = false;
        for (const target of targets) {
          const resolved = pythonFile(target);
          const members = imported.names
            .map((member) => pythonFile(path.posix.join(target, member)))
            .filter((member): member is string => member !== undefined);
          if (!resolved && !members.length) continue;
          if (resolved) add(file.path, resolved, "file", imported.module);
          for (const member of members) add(file.path, member, "file", imported.module);
          found = true;
          break;
        }
        if (!found && level)
          issues.push({
            file: file.path,
            specifier: imported.module,
            reason: "Relative Python import is absent from production files",
          });
      }
    } else {
      for (const specifier of scriptImports(file.content)) {
        const target = resolveScript(file.path, specifier);
        if (target) add(file.path, target, "file", specifier);
        else if (specifier.startsWith("."))
          issues.push({
            file: file.path,
            specifier,
            reason: "Relative script import is absent from tracked files",
          });
      }
    }
  }
  return {
    edges: [...new Map(edges.map((edge) => [JSON.stringify(edge), edge])).values()].sort((a, b) =>
      comparePaths(JSON.stringify(a), JSON.stringify(b)),
    ),
    issues: [...new Map(issues.map((issue) => [JSON.stringify(issue), issue])).values()].sort(
      (a, b) => comparePaths(JSON.stringify(a), JSON.stringify(b)),
    ),
    scannedFiles: production.filter((file) => file.content !== undefined).length,
  };
}
