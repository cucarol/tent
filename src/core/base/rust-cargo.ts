import path from "node:path";
import type { RepositoryImportIssue, RepositorySource } from "./repository-imports.js";

type Table = Record<string, unknown>;
const table = (value: unknown): value is Table =>
  !!value && typeof value === "object" && !Array.isArray(value);
const inside = (file: string) =>
  file !== ".." && !file.startsWith("../") && !path.posix.isAbsolute(file);
const crateName = (name: string) => name.replace(/-/g, "_");

function basicString(raw: string, multiline: boolean) {
  if (multiline) raw = raw.replace(/^\r?\n/, "").replace(/\\[ \t]*\r?\n\s*/g, "");
  let decoded = "";
  const escapes: Record<string, string> = {
    b: "\b",
    t: "\t",
    n: "\n",
    f: "\f",
    r: "\r",
    '"': '"',
    "\\": "\\",
  };
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "\\") {
      decoded += raw[i];
      continue;
    }
    const escape = raw[++i]!;
    if (escape === "u" || escape === "U") {
      const count = escape === "u" ? 4 : 8,
        hex = raw.slice(i + 1, i + 1 + count);
      if (!new RegExp(`^[\\da-fA-F]{${count}}$`).test(hex))
        throw new Error("invalid unicode escape");
      decoded += String.fromCodePoint(parseInt(hex, 16));
      i += count;
    } else if (escapes[escape] !== undefined) decoded += escapes[escape];
    else throw new Error("invalid string escape");
  }
  return decoded;
}

/** Read the static Cargo fields we need; reject syntax we cannot safely interpret. */
function cargoToml(text: string): Table {
  const ts: string[] = [];
  for (let i = 0; i < text.length;) {
    const c = text[i]!;
    if (c === "\r" || c === " " || c === "\t") {
      i++;
      continue;
    }
    if (c === "#") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const multiline = text.startsWith(c.repeat(3), i),
        delimiter = multiline ? c.repeat(3) : c;
      const start = (i += delimiter.length);
      while (i < text.length && !text.startsWith(delimiter, i))
        i += c === '"' && text[i] === "\\" ? 2 : 1;
      if (i >= text.length) throw new Error("unterminated string");
      let raw = text.slice(start, i);
      i += delimiter.length;
      if (c === '"') raw = basicString(raw, multiline);
      else if (multiline) raw = raw.replace(/^\r?\n/, "");
      ts.push(JSON.stringify(raw));
    } else if ("\n[]=.,{}".includes(c)) {
      ts.push(c);
      i++;
    } else {
      const start = i++;
      while (i < text.length && !/[\s#\[\]=.,{}]/.test(text[i]!)) i++;
      ts.push(text.slice(start, i));
    }
  }
  let at = 0;
  const peek = () => ts[at];
  const take = () => ts[at++];
  const expect = (v: string) => {
    if (take() !== v) throw new Error("unexpected token");
  };
  const key = () => {
    const v = take();
    if (!v || !(/^[\w-]+$/.test(v) || v.startsWith('"'))) throw new Error("invalid key");
    return v.startsWith('"') ? (JSON.parse(v) as string) : v;
  };
  const keys = () => {
    const parts = [key()];
    while (peek() === ".") {
      take();
      parts.push(key());
    }
    return parts;
  };
  function value(): unknown {
    if (peek() === "{") {
      take();
      const result: Table = Object.create(null);
      while (peek() !== "}") {
        if (peek() === "\n") {
          take();
          continue;
        }
        const parts = keys();
        expect("=");
        assign(result, parts, value());
        if (peek() !== "}") expect(",");
      }
      take();
      return result;
    }
    if (peek() === "[") {
      take();
      const result: unknown[] = [];
      while (peek() !== "]") {
        if (peek() === "\n" || peek() === ",") {
          take();
          continue;
        }
        if (peek() === undefined) throw new Error("unterminated array");
        result.push(value());
        if (![",", "\n", "]"].includes(peek() ?? "")) throw new Error("invalid array");
      }
      take();
      return result;
    }
    const v = take();
    if (!v || ["\n", "}", "]", ","].includes(v)) throw new Error("missing value");
    if (v.startsWith('"')) return JSON.parse(v);
    if (v === "true" || v === "false") return v === "true";
    // Remaining scalar values are irrelevant to import mapping (versions, dates, numbers).
    while (peek() === ".") {
      take();
      take();
    }
    return v;
  }
  function assign(root: Table, parts: string[], v: unknown) {
    let target = root;
    for (const part of parts.slice(0, -1)) {
      if (target[part] === undefined) target[part] = Object.create(null);
      if (!table(target[part])) throw new Error("conflicting keys");
      target = target[part] as Table;
    }
    const last = parts[parts.length - 1]!;
    if (target[last] !== undefined) throw new Error("duplicate key");
    target[last] = v;
  }
  const result: Table = Object.create(null);
  let current = result;
  while (at < ts.length) {
    if (peek() === "\n") {
      take();
      continue;
    }
    if (peek() === "[") {
      take();
      const array = peek() === "[";
      if (array) take();
      const parts = keys();
      expect("]");
      if (array) expect("]");
      current = result;
      for (let n = 0; n < parts.length; n++) {
        const part = parts[n]!;
        if (array && n === parts.length - 1) {
          if (current[part] === undefined) current[part] = [];
          if (!Array.isArray(current[part])) throw new Error("conflicting table");
          const child: Table = Object.create(null);
          (current[part] as unknown[]).push(child);
          current = child;
        } else {
          if (current[part] === undefined) current[part] = Object.create(null);
          const child = current[part];
          if (Array.isArray(child)) {
            if (!table(child[child.length - 1])) throw new Error("invalid array table");
            current = child[child.length - 1] as Table;
          } else if (table(child)) current = child;
          else throw new Error("conflicting table");
        }
      }
    } else {
      const parts = keys();
      expect("=");
      assign(current, parts, value());
    }
    if (peek() !== undefined && peek() !== "\n") throw new Error("trailing tokens");
  }
  return result;
}

export type RustCrate = {
  manifest: string;
  directory: string;
  name: string;
  edition: string;
  roots: string[];
  targetEditions: Map<string, string>;
  library?: string;
  libraryName: string;
  buildScript?: string;
  dependencies: Map<string, RustCrate | "external" | "unknown">;
  buildDependencies: Map<string, RustCrate | "external" | "unknown">;
};

function cargoWorkspace(manifest: string, manifests: ReadonlyMap<string, Table>) {
  const ownData = manifests.get(manifest);
  if (table(ownData?.package) && typeof ownData.package.workspace === "string") {
    const candidate = path.posix.join(
      path.posix.dirname(manifest),
      ownData.package.workspace,
      "Cargo.toml",
    );
    const data = manifests.get(candidate);
    return data && table(data.workspace) ? ([candidate, data] as const) : undefined;
  }
  return [...manifests]
    .filter(([candidate, data]) => {
      const dir = path.posix.dirname(candidate),
        own = path.posix.dirname(manifest);
      return table(data.workspace) && (dir === "." || own === dir || own.startsWith(dir + "/"));
    })
    .sort(([a], [b]) => b.length - a.length)[0];
}

function cargoDependencyTables(data: Table, includeTests = false) {
  const result: Array<{ data: Table; conditional: boolean; build?: boolean }> = [];
  if (table(data.dependencies)) result.push({ data: data.dependencies, conditional: false });
  if (includeTests && table(data["dev-dependencies"]))
    result.push({ data: data["dev-dependencies"], conditional: false });
  if (table(data["build-dependencies"]))
    result.push({ data: data["build-dependencies"], conditional: false, build: true });
  if (table(data.target))
    for (const target of Object.values(data.target))
      if (table(target)) {
        if (table(target.dependencies))
          result.push({ data: target.dependencies, conditional: true });
        if (includeTests && table(target["dev-dependencies"]))
          result.push({ data: target["dev-dependencies"], conditional: true });
        if (table(target["build-dependencies"]))
          result.push({ data: target["build-dependencies"], conditional: true, build: true });
      }
  return result;
}

/** Required Cargo facts for a narrow Rust observation; no unrelated package is read. */
export function rustCargoContext(
  files: readonly RepositorySource[],
  focus: ReadonlySet<string>,
  includeTests = false,
) {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const candidates = files
    .filter((file) => /(^|\/)Cargo\.toml$/.test(file.path))
    .map((file) => file.path);
  const ancestor = (manifest: string, file: string) => {
    const dir = path.posix.dirname(manifest);
    return dir === "." || file.startsWith(dir + "/");
  };
  const ownManifests = new Set(
    [...focus].flatMap((file) => {
      const own = candidates
        .filter((manifest) => ancestor(manifest, file))
        .sort((a, b) => b.length - a.length)[0];
      return own ? [own] : [];
    }),
  );
  const manifests = new Set(ownManifests);
  const packages = new Set(ownManifests);
  let changed = true;
  const include = (manifest: string, asPackage = false) => {
    if (inside(manifest) && byPath.has(manifest) && !manifests.has(manifest)) {
      manifests.add(manifest);
      changed = true;
    }
    if (asPackage && manifests.has(manifest) && !packages.has(manifest)) {
      packages.add(manifest);
      changed = true;
    }
  };
  while (changed) {
    changed = false;
    for (const manifest of manifests)
      for (const candidate of candidates) if (ancestor(candidate, manifest)) include(candidate);
    const parsed = new Map<string, Table>();
    for (const manifest of manifests) {
      const content = byPath.get(manifest)?.content;
      if (content === undefined) continue;
      try {
        parsed.set(manifest, cargoToml(content));
      } catch {
        /* The required configuration is diagnosed by rustCargo, never treated as absent. */
      }
    }
    for (const [manifest, data] of parsed) {
      if (table(data.package) && typeof data.package.workspace === "string")
        include(
          path.posix.join(path.posix.dirname(manifest), data.package.workspace, "Cargo.toml"),
        );
      if (!packages.has(manifest)) continue;
      const workspace = cargoWorkspace(manifest, parsed);
      for (const entry of cargoDependencyTables(data, includeTests))
        for (const [name, raw] of Object.entries(entry.data)) {
          let dep = raw,
            base = path.posix.dirname(manifest);
          if (table(dep) && dep.workspace === true) {
            const ws = workspace?.[1].workspace;
            dep = table(ws) && table(ws.dependencies) ? ws.dependencies[name] : undefined;
            if (workspace) base = path.posix.dirname(workspace[0]);
          }
          if (table(dep) && typeof dep.path === "string")
            include(path.posix.join(base, dep.path, "Cargo.toml"), true);
        }
    }
  }
  return { manifests, ownManifests, packages };
}

export function rustCargo(
  files: readonly RepositorySource[],
  issues: RepositoryImportIssue[],
  packageManifests?: ReadonlySet<string>,
  includeTests = false,
) {
  const paths = new Set(files.map((file) => file.path));
  const manifests = new Map<string, Table>();
  for (const file of files.filter((file) => /(^|\/)Cargo\.toml$/.test(file.path))) {
    try {
      if (file.content === undefined) throw new Error("missing content");
      const data = cargoToml(file.content);
      manifests.set(file.path, data);
      if (data.patch !== undefined || data.replace !== undefined)
        issues.push({
          file: file.path,
          reason: "Rust Cargo patch/replace dependency resolution requires Cargo context",
        });
    } catch {
      issues.push({ file: file.path, reason: "Cannot parse required Rust Cargo configuration" });
    }
  }
  const crates: RustCrate[] = [];
  const workspaceFor = (manifest: string) => cargoWorkspace(manifest, manifests);
  for (const [manifest, data] of manifests) {
    if (packageManifests && !packageManifests.has(manifest)) continue;
    if (!table(data.package)) continue;
    const directory = path.posix.dirname(manifest),
      pkg = data.package;
    if (typeof pkg.name !== "string") {
      issues.push({ file: manifest, reason: "Rust package name is missing or unsupported" });
      continue;
    }
    if (
      (pkg.workspace !== undefined && typeof pkg.workspace !== "string") ||
      ["autolib", "autobins"].some(
        (key) => pkg[key] !== undefined && typeof pkg[key] !== "boolean",
      ) ||
      (pkg.build !== undefined &&
        typeof pkg.build !== "boolean" &&
        typeof pkg.build !== "string") ||
      (data.lib !== undefined && !table(data.lib)) ||
      (table(data.lib) &&
        ["name", "path"].some(
          (key) =>
            data.lib &&
            (data.lib as Table)[key] !== undefined &&
            typeof (data.lib as Table)[key] !== "string",
        ))
    ) {
      issues.push({
        file: manifest,
        reason: "Rust Cargo target configuration is invalid or unsupported",
      });
      continue;
    }
    const workspace = workspaceFor(manifest)?.[1].workspace as Table | undefined;
    let edition = pkg.edition;
    if (table(edition) && edition.workspace === true) {
      edition = table(workspace?.package) ? workspace.package.edition : undefined;
      if (edition === undefined) {
        issues.push({
          file: manifest,
          reason: "Rust workspace edition inheritance is unavailable",
        });
        continue;
      }
    }
    if (edition === undefined) edition = "2015";
    if (typeof edition !== "string" || !["2015", "2018", "2021", "2024"].includes(edition)) {
      issues.push({ file: manifest, reason: "Rust package edition is unsupported" });
      continue;
    }
    const lib = table(data.lib) ? data.lib : {};
    const autoBins = pkg.autobins ?? (edition !== "2015" || data.bin === undefined);
    const library =
      lib.path !== undefined
        ? typeof lib.path === "string"
          ? path.posix.join(directory, lib.path)
          : undefined
        : !table(data.lib) && pkg.autolib === false
          ? undefined
          : path.posix.join(directory, "src/lib.rs");
    const roots = new Set<string>();
    const targetEditions = new Map<string, string>();
    const add = (file: string | undefined, explicit = false, targetEdition: unknown = edition) => {
      if (
        typeof targetEdition !== "string" ||
        !["2015", "2018", "2021", "2024"].includes(targetEdition)
      ) {
        issues.push({
          file: manifest,
          specifier: file,
          reason: "Rust target edition is unsupported",
        });
        return;
      }
      if (file && inside(file) && paths.has(file)) {
        roots.add(file);
        targetEditions.set(file, targetEdition);
      } else if (explicit)
        issues.push({
          file: manifest,
          specifier: file,
          reason: "Rust target is absent from supplied workspace files",
        });
    };
    add(library, table(data.lib), lib.edition ?? edition);
    if (autoBins) {
      add(path.posix.join(directory, "src/main.rs"));
      const prefix = path.posix.join(directory, "src/bin") + "/";
      for (const file of paths)
        if (
          file.startsWith(prefix) &&
          /^(?:[^/]+\.rs|[^/]+\/main\.rs)$/.test(file.slice(prefix.length))
        )
          add(file);
    }
    if (Array.isArray(data.bin))
      for (const bin of data.bin) {
        if (!table(bin)) continue;
        if (typeof bin.path === "string")
          add(path.posix.join(directory, bin.path), true, bin.edition ?? edition);
        else if (typeof bin.name === "string") {
          const options = [
            path.posix.join(directory, `src/bin/${bin.name}.rs`),
            path.posix.join(directory, `src/bin/${bin.name}/main.rs`),
            ...(bin.name === pkg.name ? [path.posix.join(directory, "src/main.rs")] : []),
          ].filter((file) => paths.has(file));
          if (options.length === 1) add(options[0], true, bin.edition ?? edition);
          else
            issues.push({
              file: manifest,
              specifier: bin.name,
              reason: "Rust binary target cannot be selected unambiguously",
            });
        }
      }
    if (includeTests) {
      const prefix = path.posix.join(directory, "tests") + "/";
      for (const file of paths)
        if (
          file.startsWith(prefix) &&
          /^(?:[^/]+\.rs|[^/]+\/main\.rs)$/.test(file.slice(prefix.length))
        )
          add(file);
      if (Array.isArray(data.test))
        for (const target of data.test) {
          if (!table(target)) continue;
          if (typeof target.path === "string")
            add(path.posix.join(directory, target.path), true, target.edition ?? edition);
          else if (typeof target.name === "string") {
            for (const candidate of [`tests/${target.name}.rs`, `tests/${target.name}/main.rs`])
              add(path.posix.join(directory, candidate), false, target.edition ?? edition);
          }
        }
    }
    const buildScript =
      pkg.build !== false
        ? typeof pkg.build === "string"
          ? path.posix.join(directory, pkg.build)
          : path.posix.join(directory, "build.rs")
        : undefined;
    add(buildScript, typeof pkg.build === "string");
    crates.push({
      manifest,
      directory,
      name: pkg.name,
      edition: String(edition),
      roots: [...roots].sort(),
      targetEditions,
      library: library && roots.has(library) ? library : undefined,
      libraryName: crateName(typeof lib.name === "string" ? lib.name : pkg.name),
      buildScript: buildScript && roots.has(buildScript) ? buildScript : undefined,
      dependencies: new Map(),
      buildDependencies: new Map(),
    });
  }
  for (const crate of crates) {
    const data = manifests.get(crate.manifest)!;
    const workspace = workspaceFor(crate.manifest);
    for (const entry of cargoDependencyTables(data, includeTests))
      for (const [name, raw] of Object.entries(entry.data)) {
        const dependencies = entry.build ? crate.buildDependencies : crate.dependencies;
        let dep = raw,
          base = crate.directory;
        if (table(dep) && dep.workspace === true) {
          const ws = workspace?.[1].workspace;
          const inherited = table(ws) && table(ws.dependencies) ? ws.dependencies[name] : undefined;
          if (inherited === undefined) {
            dependencies.set(crateName(name), "unknown");
            continue;
          }
          dep = table(inherited)
            ? { ...inherited, ...dep }
            : typeof inherited === "string"
              ? { version: inherited, ...dep }
              : inherited;
          base = path.posix.dirname(workspace![0]);
        }
        let resolved: RustCrate | "external" | "unknown" = "external";
        if (table(dep) && dep.path !== undefined) {
          const targetManifest =
            typeof dep.path === "string" ? path.posix.join(base, dep.path, "Cargo.toml") : "";
          const found = crates.find((candidate) => candidate.manifest === targetManifest);
          resolved =
            found &&
            (typeof dep.package === "string" ? dep.package === found.name : name === found.name) &&
            found.library
              ? found
              : "unknown";
        } else if (
          typeof dep !== "string" &&
          (!table(dep) || (typeof dep.version !== "string" && typeof dep.git !== "string"))
        )
          resolved = "unknown";
        if (
          table(dep) &&
          ((dep.package !== undefined && typeof dep.package !== "string") ||
            (dep.optional !== undefined && typeof dep.optional !== "boolean") ||
            (dep.version !== undefined && typeof dep.version !== "string") ||
            (dep.git !== undefined && typeof dep.git !== "string"))
        )
          resolved = "unknown";
        if (entry.conditional || (table(dep) && dep.optional === true)) resolved = "unknown";
        const key =
          typeof resolved === "object" && !(table(dep) && typeof dep.package === "string")
            ? resolved.libraryName
            : crateName(name);
        const previous = dependencies.get(key);
        dependencies.set(
          key,
          previous !== undefined && previous !== resolved ? "unknown" : resolved,
        );
      }
  }
  return crates;
}
