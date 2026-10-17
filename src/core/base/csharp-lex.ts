export type CSharpToken = { value: string; kind: "word" | "string" | "symbol"; escaped?: boolean };

/** Comments and all C# string forms are opaque, including interpolation bodies. */
export function csharpTokens(text: string) {
  const tokens: CSharpToken[] = [];
  const errors: string[] = [];
  let i = 0;
  function comment() {
    if (text.startsWith("//", i)) {
      while (i < text.length && !/[\r\n]/.test(text[i]!)) i++;
      return true;
    }
    if (!text.startsWith("/*", i)) return false;
    const end = text.indexOf("*/", i + 2);
    if (end < 0) errors.push("Unterminated block comment");
    i = end < 0 ? text.length : end + 2;
    return true;
  }
  function literal(): boolean {
    const prefix = /^(?:\$+@?|@\$?)?["']/.exec(text.slice(i));
    if (!prefix) return false;
    const opening = prefix[0];
    const quote = opening.at(-1)!;
    const interpolated = opening.includes("$");
    const verbatim = opening.includes("@");
    i += opening.length - 1;
    const raw = quote === '"' ? /^"{3,}/.exec(text.slice(i))?.[0] : undefined;
    if (raw) {
      i += raw.length;
      const dollars = opening.match(/\$/g)?.length ?? 0;
      while (i < text.length) {
        if (text.startsWith(raw, i)) {
          i += raw.length;
          return true;
        }
        if (dollars && text.startsWith("{".repeat(dollars), i)) {
          i += dollars;
          let depth = 1;
          while (i < text.length && depth) {
            if (comment() || literal()) continue;
            if (text[i] === "{") depth++;
            if (text[i] === "}") depth--;
            i++;
          }
          if (text.startsWith("}".repeat(dollars - 1), i)) i += dollars - 1;
        } else i++;
      }
      errors.push("Unterminated raw string literal");
      return true;
    }
    i++;
    while (i < text.length) {
      if (text[i] === quote) {
        if (verbatim && text[i + 1] === quote) {
          i += 2;
          continue;
        }
        i++;
        return true;
      }
      if (!verbatim && text[i] === "\\") {
        i += 2;
        continue;
      }
      if (interpolated && text[i] === "{") {
        if (text[i + 1] === "{") {
          i += 2;
          continue;
        }
        i++;
        let depth = 1;
        while (i < text.length && depth) {
          if (comment() || literal()) continue;
          if (text[i] === "{") depth++;
          if (text[i] === "}") depth--;
          i++;
        }
      } else i++;
    }
    errors.push("Unterminated quoted literal");
    return true;
  }
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (comment()) continue;
    if (literal()) {
      tokens.push({ value: "", kind: "string" });
      continue;
    }
    if (c === "#" && /^[ \t]*$/.test(text.slice(text.lastIndexOf("\n", i - 1) + 1, i))) {
      const start = i;
      while (i < text.length && !/[\r\n]/.test(text[i]!)) i++;
      if (/^#\s*(?:if|elif|else|endif|define|undef)\b/.test(text.slice(start, i)))
        errors.push("Conditional compilation is not evaluated");
      continue;
    }
    const escaped = c === "@" && /[\p{ID_Start}_]/u.test(text[i + 1] ?? "");
    if (escaped || /[\p{ID_Start}_]/u.test(c)) {
      if (escaped) i++;
      const start = i++;
      while (i < text.length && /[\p{ID_Continue}]/u.test(text[i]!)) i++;
      tokens.push({ value: text.slice(start, i), kind: "word", escaped });
    } else tokens.push({ value: text[i++]!, kind: "symbol" });
  }
  return { tokens, errors };
}
