export type JavaToken = {
  value: string;
  kind: "word" | "string" | "symbol";
  start: number;
  end: number;
};

/** Java comments, literals and text blocks are opaque to declaration parsing. */
export function javaTokens(text: string) {
  const tokens: JavaToken[] = [];
  const errors: string[] = [];
  let i = 0;
  while (i < text.length) {
    const tokenStart = i;
    const c = text[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (text.startsWith("//", i)) {
      while (i < text.length && !/[\r\n]/.test(text[i]!)) i++;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) errors.push("Unterminated block comment");
      i = end < 0 ? text.length : end + 2;
    } else if (c === '"' || c === "'") {
      const delimiter = text.startsWith('"""', i) ? '"""' : c;
      i += delimiter.length;
      const start = i;
      while (i < text.length && !text.startsWith(delimiter, i)) {
        if (text[i] === "\\") i += 2;
        else i++;
      }
      const value = text.slice(start, i);
      if (i >= text.length) errors.push("Unterminated quoted literal");
      i = Math.min(text.length, i + delimiter.length);
      tokens.push({ value, kind: "string", start: tokenStart, end: i });
    } else if (/[\p{ID_Start}_$]/u.test(c)) {
      const start = i++;
      while (i < text.length && /[\p{ID_Continue}$]/u.test(text[i]!)) i++;
      tokens.push({ value: text.slice(start, i), kind: "word", start, end: i });
    } else tokens.push({ value: text[i++]!, kind: "symbol", start: tokenStart, end: i });
  }
  return { tokens, errors };
}
