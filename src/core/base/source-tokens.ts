export type SourceToken = {
  value: string;
  kind: "word" | "string" | "symbol";
  start: number;
  end: number;
};

/** Small lexical pass: quoted examples and comments never become import statements. */
export function sourceTokens(text: string, python = false, go = false): SourceToken[] {
  const result: SourceToken[] = [];
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
