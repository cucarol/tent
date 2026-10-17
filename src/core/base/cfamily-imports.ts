import path from "node:path";
import type {
  RepositoryImport,
  RepositoryImportIssue,
  RepositorySource,
} from "./repository-imports.js";

export const isCFamilySource = (file: string) =>
  /\.(?:c|cc|cpp|cxx|C|h|hh|hpp|hxx|inc|inl|ipp|tpp)$/.test(file);
export const isCFamilyConfig = (file: string) =>
  /(^|\/)(?:CMakeLists\.txt|compile_commands\.json)$/.test(file);

type Include = { name: string; quoted: boolean };

/** Translation-phase line splicing precedes comment and literal recognition. */
function includes(file: RepositorySource, issues: RepositoryImportIssue[]): Include[] {
  const text = (file.content ?? "").replace(/\\\r?\n/g, "");
  let clean = "",
    code = "",
    i = 0;
  const mask = (value: string) => value.replace(/[^\r\n]/g, " ");
  const issue = (reason: string, specifier?: string) =>
    issues.push({ file: file.path, reason, ...(specifier === undefined ? {} : { specifier }) });
  while (i < text.length) {
    const start = i;
    if (text.startsWith("//", i)) {
      const end = text.indexOf("\n", i + 2);
      i = end < 0 ? text.length : end;
      clean += mask(text.slice(start, i));
      code += mask(text.slice(start, i));
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) issue("Cannot parse C/C++ source: unterminated block comment");
      i = end < 0 ? text.length : end + 2;
      clean += mask(text.slice(start, i));
      code += mask(text.slice(start, i));
    } else if ((i === 0 || !/[\w]/.test(text[i - 1]!)) && /^(?:u8|u|U|L)?R"/.test(text.slice(i))) {
      const opening = /^(?:u8|u|U|L)?R"([^ ()\\\t\r\n]{0,16})\(/.exec(text.slice(i));
      if (!opening) {
        issue("Cannot parse C/C++ source: invalid raw string");
        i++;
        clean += " ";
        code += " ";
        continue;
      }
      const end = text.indexOf(`)${opening[1]}"`, i + opening[0].length);
      if (end < 0) issue("Cannot parse C/C++ source: unterminated raw string");
      i = end < 0 ? text.length : end + opening[1]!.length + 2;
      clean += mask(text.slice(start, i));
      code += text.slice(start, i).replace(/[^\r\n]/g, "@");
    } else if (/\d/.test(text[i]!) && (i === 0 || !/\w/.test(text[i - 1]!))) {
      // C++ digit separators are part of numeric preprocessing tokens.
      while (i < text.length && /[\w'.]/.test(text[i]!)) i++;
      clean += text.slice(start, i);
      code += text.slice(start, i);
    } else if (text[i] === '"' || text[i] === "'") {
      const delimiter = text[i++]!;
      while (i < text.length && text[i] !== delimiter && text[i] !== "\n") {
        if (text[i] === "\\") i += 2;
        else i++;
      }
      if (text[i] === delimiter) i++;
      else issue("Cannot parse C/C++ source: unterminated literal");
      clean += text.slice(start, i);
      code += text.slice(start, i).replace(/[^\r\n]/g, "@");
    } else {
      clean += text[i];
      code += text[i++];
    }
  }
  const result: Include[] = [];
  const lines = clean.split("\n");
  for (const [index, line] of code.split("\n").entries()) {
    const directive = /^\s*#\s*(include_next|include)\b/.exec(line);
    if (!directive) continue;
    const rest = lines[index]!.slice(directive[0].length).trim();
    if (directive[1] === "include_next") {
      issue("C/C++ include_next search order is not resolved", rest);
      continue;
    }
    const literal = /^(?:"([^"\r\n]+)"|<([^>\r\n]+)>)\s*$/.exec(rest);
    if (!literal) {
      issue("C/C++ include is not a literal header name", rest);
      continue;
    }
    result.push({ name: literal[1] ?? literal[2]!, quoted: literal[1] !== undefined });
  }
  return result;
}

/** Pure local include evidence, without evaluating preprocessor conditions or macros. */
export function extractCFamilyImports(
  input: readonly RepositorySource[],
  focus?: readonly string[],
) {
  const files = [...input].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const byPath = new Map(files.map((file) => [file.path, file]));
  const issues: RepositoryImportIssue[] = [];
  const edges: RepositoryImport[] = [];
  const requiredFiles = new Set<string>();
  const sources = files.filter(
    (file) => isCFamilySource(file.path) && (focus === undefined || focus.includes(file.path)),
  );
  for (const config of files.filter((file) => isCFamilyConfig(file.path))) {
    const directory = path.posix.dirname(config.path);
    if (!sources.some((source) => directory === "." || source.path.startsWith(directory + "/")))
      continue;
    requiredFiles.add(config.path);
    issues.push({
      file: config.path,
      reason:
        config.content === undefined
          ? "Required C/C++ build configuration bytes are unavailable"
          : "C/C++ build include search paths are not evaluated; only source-relative quoted includes are resolved",
    });
  }
  for (const file of sources) {
    requiredFiles.add(file.path);
    if (file.content === undefined) {
      issues.push({ file: file.path, reason: "Required C/C++ source bytes are unavailable" });
      continue;
    }
    for (const include of includes(file, issues)) {
      // Quoted names have a defined source-relative first lookup. Other search
      // roots require build configuration; no global basename guessing.
      const candidate = path.posix.normalize(
        path.posix.join(path.posix.dirname(file.path), include.name),
      );
      const local =
        include.quoted &&
        !path.posix.isAbsolute(include.name) &&
        !/^[A-Za-z]:|\\/.test(include.name) &&
        candidate !== ".." &&
        !candidate.startsWith("../")
          ? byPath.get(candidate)
          : undefined;
      if (local) {
        if (file.path !== local.path)
          edges.push({ from: file.path, to: local.path, kind: "file", specifier: include.name });
      } else if (include.quoted)
        issues.push({
          file: file.path,
          specifier: include.name,
          reason: "Quoted C/C++ include is absent from local source-relative files",
        });
    }
  }
  return { edges, issues, requiredFiles: [...requiredFiles].sort() };
}
