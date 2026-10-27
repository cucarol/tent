import type { RepositoryImport } from "./repository-imports.js";

type Token = { value: string; kind: string; start: number; end: number };
type Statement = { tokens: Token[]; indent: number; line: number };
type Import = { module: string; names: string[]; execution: RepositoryImport["execution"] };

export function pythonStatements(text: string, tokens: Token[]): Statement[] {
  const result: Statement[] = [];
  let current: Token[] = [];
  let depth = 0;
  let line = 0;
  let indent = 0;
  let previous = 0;
  let joined = false;
  const flush = () => {
    if (current.length) result.push({ tokens: current, indent, line });
    current = [];
  };
  for (const token of tokens) {
    const between = text.slice(previous, token.start);
    if (depth === 0 && /\n/.test(between) && !joined) flush();
    joined =
      token.kind === "symbol" &&
      token.value === "\\" &&
      /^\r?\n/.test(text.slice(token.end, token.end + 2));
    if (!current.length) {
      line = text.lastIndexOf("\n", token.start - 1) + 1;
      const whitespace = /^[ \t]*/.exec(text.slice(line))![0];
      indent = 0;
      for (const c of whitespace) indent = c === "\t" ? indent + 8 - (indent % 8) : indent + 1;
    }
    if (token.kind === "symbol" && token.value === ";" && depth === 0) flush();
    else if (!joined) current.push(token);
    if (token.kind === "symbol") {
      if (["(", "[", "{"].includes(token.value)) depth++;
      if ([")", "]", "}"].includes(token.value)) depth--;
    }
    previous = token.end;
  }
  flush();
  return result;
}

/** Python suite context, without running Python or following calls/constant expressions. */
export function pythonImports(text: string, tokens: Token[]): Import[] {
  const result: Import[] = [];
  const guards = new Set<string>();
  const typing = new Set<string>();
  const blocks: Array<{ indent: number; execution: Import["execution"] }> = [];
  let previousLine = -1;
  let inline: Import["execution"] | undefined;
  const guard = (condition: Token[]) => {
    // Only positive, optionally parenthesized TYPE_CHECKING guards are recognized.
    while (condition[0]?.value === "(" && condition[condition.length - 1]?.value === ")") {
      let depth = 0;
      const closing = condition.findIndex((token) => {
        if (token.value === "(") depth++;
        if (token.value === ")") depth--;
        return depth === 0;
      });
      if (closing !== condition.length - 1) break;
      condition = condition.slice(1, -1);
    }
    if (condition.some((token) => token.kind !== "word" && token.value !== ".")) return false;
    const name = condition.map((token) => token.value).join("");
    return guards.has(name) || (name.endsWith(".TYPE_CHECKING") && typing.has(name.slice(0, -14)));
  };
  for (const statement of pythonStatements(text, tokens)) {
    if (statement.line !== previousLine) {
      while (blocks.length && blocks[blocks.length - 1]!.indent >= statement.indent) blocks.pop();
      inline = undefined;
    }
    previousLine = statement.line;
    const inherited = blocks.some((block) => block.execution === "type-only")
      ? "type-only"
      : blocks.some((block) => block.execution === "deferred")
        ? "deferred"
        : "module-load";
    let execution = inline ?? inherited;
    let ts = statement.tokens;
    const first = ts[0]?.value;
    if (
      [
        "if",
        "elif",
        "class",
        "def",
        "async",
        "else",
        "try",
        "except",
        "finally",
        "for",
        "while",
        "with",
        "match",
        "case",
      ].includes(first ?? "")
    ) {
      let depth = 0;
      const colon = ts.findIndex((token) => {
        if (token.kind !== "symbol") return false;
        if (["(", "[", "{"].includes(token.value)) depth++;
        if ([")", "]", "}"].includes(token.value)) depth--;
        return token.value === ":" && depth === 0;
      });
      if (colon >= 0) {
        if (execution !== "type-only") {
          if (["if", "elif"].includes(first!) && guard(ts.slice(1, colon))) execution = "type-only";
          else if (first === "def" || (first === "async" && ts[1]?.value === "def"))
            execution = "deferred";
        }
        blocks.push({ indent: statement.indent, execution });
        ts = ts.slice(colon + 1);
        if (ts.length) inline = execution;
      }
    }
    if (ts[0]?.kind !== "word") continue;
    const values = ts.filter((token) => token.value !== "\\").map((token) => token.value);
    const imported = values.indexOf("import");
    if (!(values[0] === "import" || (values[0] === "from" && imported > 1))) continue;
    const module = values[0] === "from" ? values.slice(1, imported).join("") : undefined;
    // Use token groups, so alias boundaries remain distinct from identifier text.
    const names: Array<{ name: string; alias: string }> = [];
    let group: string[] = [];
    for (const value of [...values.slice(imported + 1), ","]) {
      if (["(", ")"].includes(value)) continue;
      if (value !== ",") {
        group.push(value);
        continue;
      }
      if (group.length) {
        const as = group.indexOf("as");
        const name = (as < 0 ? group : group.slice(0, as)).join("");
        names.push({ name, alias: as < 0 ? name : group[as + 1]! });
      }
      group = [];
    }
    if (module !== undefined) {
      result.push({ module, names: names.map((name) => name.name), execution });
      if (["typing", "typing_extensions"].includes(module))
        for (const name of names) if (name.name === "TYPE_CHECKING") guards.add(name.alias);
    } else {
      for (const name of names) {
        result.push({ module: name.name, names: [], execution });
        if (["typing", "typing_extensions"].includes(name.name)) typing.add(name.alias);
      }
    }
  }
  return result;
}
