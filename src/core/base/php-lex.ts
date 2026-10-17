export type PhpToken = { value: string; kind: "word" | "string" | "opaque" | "symbol" };

/** Only PHP code regions are tokens; comments and interpolated/string bodies stay opaque. */
export function phpTokens(text: string) {
  const tokens: PhpToken[] = [];
  const errors: string[] = [];
  let i = 0;
  let code = false;
  while (i < text.length) {
    if (!code) {
      const opening = /<\?(?:php(?:\s|$)|=|xml\b)?/gi;
      opening.lastIndex = i;
      const match = opening.exec(text);
      if (!match) break;
      i = match.index + match[0].length;
      if (match[0] === "<?") {
        errors.push("short open tags require runtime configuration");
        const end = text.indexOf("?>", i);
        i = end < 0 ? text.length : end + 2;
        continue;
      }
      if (/^<\?xml/i.test(match[0])) continue;
      code = true;
      continue;
    }
    const c = text[i]!;
    if (text.startsWith("?>", i)) {
      tokens.push({ kind: "symbol", value: ";" });
      i += 2;
      code = false;
    } else if (/\s/.test(c)) i++;
    else if (text.startsWith("//", i) || (c === "#" && text[i + 1] !== "[")) {
      while (i < text.length && text[i] !== "\n" && !text.startsWith("?>", i)) i++;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) errors.push("unterminated block comment");
      i = end < 0 ? text.length : end + 2;
    } else if (text.startsWith("<<<", i)) {
      const opening =
        /^<<<[ \t]*(?:'([A-Za-z_][\w]*)'|"([A-Za-z_][\w]*)"|([A-Za-z_][\w]*))[ \t]*\r?\n/.exec(
          text.slice(i),
        );
      if (!opening) {
        errors.push("invalid heredoc/nowdoc opener");
        i = text.length;
        continue;
      }
      const label = opening[1] ?? opening[2] ?? opening[3]!;
      const ending = new RegExp(`^[ \\t]*${label}(?![A-Za-z0-9_])`, "gm");
      ending.lastIndex = i + opening[0].length;
      const end = ending.exec(text);
      if (!end) errors.push("unterminated heredoc/nowdoc");
      i = end ? end.index + end[0].length : text.length;
      tokens.push({ kind: "opaque", value: "" });
    } else if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      i++;
      let value = "";
      let opaque = quote === "`";
      const modes: Array<{ quote: string } | { braces: number }> = [{ quote }];
      while (i < text.length && modes.length) {
        const mode = modes[modes.length - 1]!;
        if ("braces" in mode) {
          if (text.startsWith("//", i) || text[i] === "#") {
            while (i < text.length && text[i] !== "\n") i++;
          } else if (text.startsWith("/*", i)) {
            const end = text.indexOf("*/", i + 2);
            i = end < 0 ? text.length : end + 2;
          } else if (["'", '"', "`"].includes(text[i]!)) {
            modes.push({ quote: text[i++]! });
          } else if (text[i] === "{") {
            mode.braces++;
            i++;
          } else if (text[i++] === "}" && --mode.braces === 0) modes.pop();
          continue;
        }
        if (text[i] === mode.quote) {
          i++;
          modes.pop();
          continue;
        }
        if (mode.quote !== "'" && (text.startsWith("{$", i) || text.startsWith("${", i))) {
          opaque = true;
          modes.push({ braces: 1 });
          i += 2;
          continue;
        }
        if (modes.length !== 1) {
          i += text[i] === "\\" ? 2 : 1;
          continue;
        }
        if (text[i] === "\\") {
          const next = text[i + 1];
          if (next === undefined) {
            i++;
            break;
          }
          if (next === "\\" || next === quote || (quote === '"' && next === "$")) value += next;
          else if (quote === '"' && "nrtvef".includes(next))
            value += (
              { n: "\n", r: "\r", t: "\t", v: "\v", e: "\x1b", f: "\f" } as Record<string, string>
            )[next];
          else if (quote === '"' && /[0-7xu]/i.test(next)) opaque = true;
          else value += "\\" + next;
          i += 2;
        } else {
          if (quote === '"' && text[i] === "$") opaque = true;
          value += text[i++];
        }
      }
      if (modes.length) errors.push("unterminated quoted literal");
      tokens.push({ kind: opaque ? "opaque" : "string", value });
    } else if (/[A-Za-z_\x80-\uffff$0-9]/.test(c)) {
      const start = i++;
      while (i < text.length && /[A-Za-z_\x80-\uffff$0-9]/.test(text[i]!)) i++;
      if (
        /^__halt_compiler$/i.test(text.slice(start, i)) &&
        !["->", "::", "\\"].includes(tokens.at(-1)?.value ?? "") &&
        /^\s*\(\s*\)\s*;/.test(text.slice(i))
      )
        break;
      tokens.push({ kind: "word", value: text.slice(start, i) });
    } else {
      const pair = text.slice(i, i + 2);
      const value = ["->", "::", "=>"].includes(pair) ? pair : c;
      tokens.push({ kind: "symbol", value });
      i += value.length;
    }
  }
  return { tokens, errors };
}
