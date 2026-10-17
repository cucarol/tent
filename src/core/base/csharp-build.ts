import path from "node:path";
import type { RepositoryImportIssue, RepositorySource } from "./repository-imports.js";

export const isCSharpConfig = (file: string) =>
  /\.csproj$/.test(file) || /(^|\/)Directory\.Build\.(?:props|targets)$/.test(file);
type Element = {
  name: string;
  attributes: Record<string, string>;
  text: string;
  children: Element[];
};

/** No DTD, external entities, MSBuild evaluation or file access. */
function projectXml(text: string): Element {
  const root: Element = { name: "", attributes: {}, text: "", children: [] };
  const stack = [root];
  const parts =
    text.match(
      /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+/g,
    ) ?? [];
  if (parts.join("") !== text) throw new Error("Invalid XML");
  const decode = (value: string) => {
    if (/&(?![^&;\s]+;)/.test(value)) throw new Error("Invalid XML entity");
    return value.replace(/&([^;]+);/g, (_all, entity: string) => {
      const known: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
      if (Object.prototype.hasOwnProperty.call(known, entity)) return known[entity]!;
      const numeric = /^#(x[0-9a-f]+|[0-9]+)$/i.exec(entity)?.[1];
      if (numeric)
        return String.fromCodePoint(
          parseInt(numeric.replace(/^x/i, ""), /^x/i.test(numeric) ? 16 : 10),
        );
      throw new Error("Unsupported XML entity");
    });
  };
  for (const part of parts) {
    const current = stack.at(-1)!;
    if (part.startsWith("<!--") || part.startsWith("<?")) continue;
    if (part.startsWith("<![CDATA[")) current.text += part.slice(9, -3);
    else if (part.startsWith("<!")) throw new Error("XML declarations/entities are unsupported");
    else if (part.startsWith("</")) {
      if (stack.length === 1 || /^<\/([\w:.-]+)\s*>$/.exec(part)?.[1] !== current.name)
        throw new Error("Invalid XML nesting");
      stack.pop();
    } else if (part.startsWith("<")) {
      const match = /^<([\w:.-]+)([\s\S]*?)\/?\s*>$/.exec(part);
      if (!match) throw new Error("Invalid XML element");
      let rest = match[2]!.trim();
      const attributes: Record<string, string> = {};
      while (rest) {
        const attr = /^([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*/.exec(rest);
        if (!attr || Object.prototype.hasOwnProperty.call(attributes, attr[1]!))
          throw new Error("Invalid XML attributes");
        attributes[attr[1]!] = decode(attr[2] ?? attr[3]!);
        rest = rest.slice(attr[0].length);
      }
      const child = { name: match[1]!, attributes, text: "", children: [] };
      current.children.push(child);
      if (!/\/\s*>$/.test(part)) stack.push(child);
    } else current.text += decode(part);
  }
  if (
    stack.length !== 1 ||
    root.text.trim() ||
    root.children.length !== 1 ||
    root.children[0]?.name !== "Project"
  )
    throw new Error("Expected a complete MSBuild Project element");
  return root.children[0]!;
}

/** Closest project directory and literal project references bound local candidates. */
export function csharpProjects(
  files: readonly RepositorySource[],
  issues: RepositoryImportIssue[],
  focus?: ReadonlySet<string>,
) {
  const projects = files.filter((file) => file.path.endsWith(".csproj"));
  const byPath = new Map(files.map((file) => [file.path, file]));
  const requiredFiles = new Set<string>();
  const references = new Map<string, string[]>();
  const owners = (file: string) => {
    const candidates = projects
      .filter((project) => {
        const directory = path.posix.dirname(project.path);
        return directory === "." || file.startsWith(directory + "/");
      })
      .sort((a, b) => path.posix.dirname(b.path).length - path.posix.dirname(a.path).length);
    const directory = candidates[0] && path.posix.dirname(candidates[0].path);
    return candidates
      .filter((candidate) => path.posix.dirname(candidate.path) === directory)
      .map((candidate) => candidate.path);
  };
  const pending = focus
    ? [...new Set([...focus].flatMap(owners))]
    : projects.map((file) => file.path);
  const inspected = new Set<string>();
  while (pending.length) {
    const filename = pending.pop()!;
    if (inspected.has(filename)) continue;
    inspected.add(filename);
    requiredFiles.add(filename);
    references.set(filename, []);
    const file = byPath.get(filename);
    if (file?.content === undefined) {
      issues.push({ file: filename, reason: "C# project configuration bytes are unavailable" });
      continue;
    }
    const issue = (reason: string) => issues.push({ file: filename, reason });
    try {
      const project = projectXml(file.content);
      function visit(element: Element, conditional = false) {
        conditional ||= element.attributes.Condition !== undefined || element.name === "Choose";
        if (element.name === "ProjectReference") {
          const value = element.attributes.Include?.replace(/\\/g, "/");
          if (conditional || !value || /[$@%*?;]|^[A-Za-z]:|^\//.test(value))
            issue("Cannot resolve C# ProjectReference statically");
          else {
            const target = path.posix.join(path.posix.dirname(filename), value);
            if (
              target === ".." ||
              target.startsWith("../") ||
              !byPath.has(target) ||
              !target.endsWith(".csproj")
            )
              issue("C# ProjectReference is absent from Workspace projects");
            else {
              references.get(filename)!.push(target);
              pending.push(target);
            }
          }
        }
        if (
          [
            "Compile",
            "Import",
            "Using",
            "EnableDefaultCompileItems",
            "DefaultItemExcludes",
            "DefineConstants",
          ].includes(element.name) ||
          (element.name === "ImplicitUsings" && !/^(?:disable|false)$/.test(element.text.trim()))
        )
          issue("Custom C# source, using or imported MSBuild configuration is not evaluated");
        if (conditional && (element.name === "PropertyGroup" || element.name === "ItemGroup"))
          issue("Conditional MSBuild configuration is not evaluated");
        for (const child of element.children) visit(child, conditional);
      }
      visit(project);
    } catch (error) {
      issue(`Cannot parse C# project configuration: ${(error as Error).message}`);
    }
    for (const config of files.filter((candidate) =>
      /^Directory\.Build\.(?:props|targets)$/.test(path.posix.basename(candidate.path)),
    )) {
      const directory = path.posix.dirname(config.path);
      if (directory === "." || filename.startsWith(directory + "/")) {
        requiredFiles.add(config.path);
        issues.push({
          file: config.path,
          reason: "Directory.Build MSBuild configuration is not evaluated",
        });
      }
    }
  }
  const reachable = (file: string) => {
    const seen = new Set<string>();
    const queue = [...owners(file)];
    while (queue.length) {
      const project = queue.pop()!;
      if (seen.has(project)) continue;
      seen.add(project);
      queue.push(...(references.get(project) ?? []));
    }
    return seen;
  };
  return { owners, reachable, requiredFiles };
}
