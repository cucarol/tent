import path from "node:path";
import type { RepositoryImportIssue, RepositorySource } from "./repository-imports.js";
import { javaTokens } from "./java-lex.js";

export const isJavaConfig = (file: string) =>
  /(^|\/)(pom\.xml|(?:build|settings)\.gradle(?:\.kts)?)$/.test(file);

type Element = { name: string; text: string; children: Element[] };

/** Only structural XML is read. No DTD, external entities or Maven evaluation. */
function xml(text: string): Element {
  const root: Element = { name: "", text: "", children: [] };
  const stack = [root];
  const parts =
    text.match(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/g) ?? [];
  if (parts.join("") !== text) throw new Error("Invalid XML");
  for (const part of parts) {
    const current = stack[stack.length - 1]!;
    if (part.startsWith("<!--") || part.startsWith("<?")) continue;
    if (part.startsWith("<![CDATA[")) current.text += part.slice(9, -3);
    else if (part.startsWith("<!")) throw new Error("XML declarations/entities are unsupported");
    else if (part.startsWith("</")) {
      if (stack.length === 1 || /^<\/([\w:.-]+)\s*>$/.exec(part)?.[1] !== current.name)
        throw new Error("Invalid XML nesting");
      stack.pop();
    } else if (part.startsWith("<")) {
      const name = /^<([\w:.-]+)(?:\s[^<>]*?)?\s*\/?>$/.exec(part)?.[1];
      if (!name) throw new Error("Invalid XML element");
      const child = { name, text: "", children: [] };
      current.children.push(child);
      if (!part.endsWith("/>")) stack.push(child);
    } else current.text += part;
  }
  if (
    stack.length !== 1 ||
    root.text.trim() ||
    root.children.length !== 1 ||
    root.children[0]?.name !== "project"
  )
    throw new Error("Expected a complete Maven project element");
  return root.children[0]!;
}

const child = (element: Element | undefined, name: string) =>
  element?.children.find((item) => item.name === name);
const localPath = (directory: string, value: string) => {
  if (!value || /[${}&\\]|^[A-Za-z]:|^\//.test(value)) return;
  const target = path.posix.join(directory, value);
  if (target === ".." || target.startsWith("../")) return;
  return target;
};

/** Conventional roots plus the common literal Maven sourceDirectory override. */
export function javaBuildRoots(
  files: readonly RepositorySource[],
  issues: RepositoryImportIssue[],
  focus?: ReadonlySet<string>,
) {
  const roots = new Set<string>();
  const configurations = files.filter((file) => isJavaConfig(file.path));
  for (const file of files) {
    const match = /^(.*?)(?:^|\/)src\/main\/java(?:\/|$)/.exec(file.path);
    if (match) roots.add(path.posix.join(match[1] ?? ".", "src/main/java"));
  }
  for (const file of configurations) {
    const directory = path.posix.dirname(file.path);
    if (
      focus &&
      ![...focus].some((member) => directory === "." || member.startsWith(directory + "/"))
    )
      continue;
    roots.add(path.posix.join(directory, "src/main/java"));
    if (file.content === undefined) {
      issues.push({ file: file.path, reason: "Java build configuration bytes are unavailable" });
      continue;
    }
    try {
      if (file.path.endsWith("pom.xml")) {
        const project = xml(file.content);
        const source = child(child(project, "build"), "sourceDirectory")?.text.trim();
        if (source !== undefined) {
          const relative = source.replace(/^\$\{(?:project\.)?basedir\}\//, "");
          const target = localPath(directory, relative);
          if (target) roots.add(target);
          else
            issues.push({
              file: file.path,
              reason: "Cannot resolve Maven sourceDirectory statically",
            });
        }
        for (const module of child(project, "modules")?.children ?? []) {
          const target =
            module.name === "module" ? localPath(directory, module.text.trim()) : undefined;
          if (target) roots.add(path.posix.join(target, "src/main/java"));
          else
            issues.push({
              file: file.path,
              reason: "Cannot resolve Maven module declaration statically",
            });
        }
        if (child(project, "profiles")?.children.length)
          issues.push({ file: file.path, reason: "Maven build profiles are not evaluated" });
        const plugins = child(child(project, "build"), "plugins");
        if (
          plugins?.children.some(
            (plugin) => child(plugin, "artifactId")?.text.trim() === "build-helper-maven-plugin",
          )
        )
          issues.push({
            file: file.path,
            reason: "Maven plugin-added source roots are not evaluated",
          });
      } else {
        const { tokens, errors } = javaTokens(file.content);
        const words = tokens.filter((token) => token.kind === "word").map((token) => token.value);
        if (errors.length) throw new Error(errors.join("; "));
        const brackets: string[] = [];
        for (const token of tokens) {
          if (token.kind === "string") continue;
          if (["{", "(", "["].includes(token.value)) brackets.push(token.value);
          if (
            ["}", ")", "]"].includes(token.value) &&
            brackets.pop() !== { "}": "{", ")": "(", "]": "[" }[token.value]
          )
            throw new Error("Unbalanced Gradle configuration");
        }
        if (brackets.length) throw new Error("Unbalanced Gradle configuration");
        const appliedScript = tokens.some(
          (token, index) =>
            token.kind === "word" &&
            token.value === "apply" &&
            (tokens[index + 1]?.value === "from" ||
              (tokens[index + 1]?.value === "(" && tokens[index + 2]?.value === "from")),
        );
        if (
          appliedScript ||
          words.some((word) =>
            ["sourceSets", "srcDirs", "srcDir", "projectDir", "includeBuild"].includes(word),
          )
        )
          issues.push({
            file: file.path,
            reason: "Custom or applied Gradle source/project configuration is not evaluated",
          });
        // Literal settings includes describe standard-layout subprojects. Project
        // dependencies need no execution: imported types still require a unique local definition.
        for (
          let i = 0;
          /(^|\/)settings\.gradle(?:\.kts)?$/.test(file.path) && i < tokens.length;
          i++
        ) {
          if (tokens[i]?.kind !== "word" || tokens[i]?.value !== "include") continue;
          const symbol = (index: number, value: string) =>
            tokens[index]?.kind === "symbol" && tokens[index]?.value === value;
          let j = i + 1;
          const parenthesized = symbol(j, "(");
          if (parenthesized) j++;
          if (!parenthesized && j === tokens.length)
            issues.push({
              file: file.path,
              reason: "Dynamic Gradle project include is not evaluated",
            });
          while (j < tokens.length && !(parenthesized && symbol(j, ")"))) {
            const start = j;
            const nested: string[] = [];
            // Confirm the whole argument before accepting a literal. Expressions
            // are opaque, including nested calls with their own commas.
            for (; j < tokens.length; j++) {
              const token = tokens[j]!;
              if (!nested.length) {
                if (symbol(j, ",") || (parenthesized && symbol(j, ")"))) break;
                if (!parenthesized && (symbol(j, ";") || symbol(j, "}"))) break;
                if (
                  !parenthesized &&
                  j > start &&
                  /[\r\n]/.test(file.content.slice(tokens[j - 1]!.end, token.start)) &&
                  ![
                    ".",
                    "+",
                    "-",
                    "*",
                    "/",
                    "%",
                    "?",
                    "&",
                    "|",
                    "^",
                    "=",
                    "<",
                    ">",
                    "[",
                    "(",
                  ].includes(token.value) &&
                  ![".", "+", "-", "*", "/", "%", "?", ":", "&", "|", "^", "=", "<", ">"].includes(
                    tokens[j - 1]!.value,
                  )
                )
                  break;
              }
              if (token.kind !== "string") {
                if (["(", "[", "{"].includes(token.value)) nested.push(token.value);
                else if ([")", "]", "}"].includes(token.value)) nested.pop();
              }
            }
            if (j === start + 1 && tokens[start]?.kind === "string") {
              const target = localPath(
                directory,
                tokens[start]!.value.replace(/^:/, "").replace(/:/g, "/"),
              );
              if (target) roots.add(path.posix.join(target, "src/main/java"));
              else
                issues.push({
                  file: file.path,
                  reason: "Cannot resolve Gradle project include statically",
                });
            } else {
              issues.push({
                file: file.path,
                reason: "Dynamic Gradle project include is not evaluated",
              });
            }
            if (!symbol(j, ",")) break;
            j++;
            // Kotlin permits a trailing comma before the closing call parenthesis.
            if (parenthesized && symbol(j, ")")) break;
            if (j === tokens.length)
              issues.push({
                file: file.path,
                reason: "Dynamic Gradle project include is not evaluated",
              });
          }
          i = parenthesized ? j : j - 1;
        }
      }
    } catch (error) {
      issues.push({
        file: file.path,
        reason: `Cannot parse Java build configuration: ${(error as Error).message}`,
      });
    }
  }
  return roots;
}
