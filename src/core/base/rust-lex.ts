/** Rust tokens keep strings opaque and distinguish character literals from lifetimes. */
export type RustToken = { value: string; string?: boolean; raw?: boolean; invalid?: boolean };

export function rustTokens(text: string): RustToken[] {
  const out: RustToken[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (text.startsWith("//", i)) {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (text.startsWith("/*", i)) {
      i += 2;
      let depth = 1;
      while (i < text.length && depth) {
        if (text.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (text.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth) out.push({ value: "", invalid: true });
      continue;
    }
    const raw = /^(?:br|cr|r)(#*)"/.exec(text.slice(i));
    if (raw) {
      const start = i + raw[0].length,
        end = text.indexOf('"' + raw[1], start);
      out.push({ value: text.slice(start, end < 0 ? text.length : end), string: true });
      if (end < 0) out.push({ value: "", invalid: true });
      i = end < 0 ? text.length : end + 1 + raw[1]!.length;
      continue;
    }
    if (c === '"' || ((c === "b" || c === "c") && text[i + 1] === '"')) {
      if (c !== '"') i++;
      const start = ++i;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      out.push({ value: text.slice(start, i), string: true });
      if (i >= text.length) out.push({ value: "", invalid: true });
      i = Math.min(text.length, i + 1);
      continue;
    }
    const character =
      /^(?:b)?'(?:\\(?:u\{[\da-fA-F_]+\}|x[\da-fA-F]{2}|[^\r\n])|[^'\\\r\n])'/u.exec(text.slice(i));
    if (character) {
      out.push({ value: "", string: true });
      i += character[0].length;
      continue;
    }
    const word = /^(?:r#)?[\p{L}_][\p{L}\p{N}_]*/u.exec(text.slice(i));
    if (word) {
      out.push({ value: word[0].replace(/^r#/, ""), raw: word[0].startsWith("r#") });
      i += word[0].length;
      continue;
    }
    if (text.startsWith("::", i)) {
      out.push({ value: "::" });
      i += 2;
      continue;
    }
    out.push({ value: c });
    i++;
  }
  return out;
}

/** End just after a balanced token group; strings cannot supply delimiters. */
export function rustGroupEnd(ts: readonly RustToken[], start: number): number {
  const close = new Map([
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ]);
  const stack = [close.get(ts[start]?.value ?? "")];
  if (!stack[0]) return start + 1;
  for (let i = start + 1; i < ts.length; i++) {
    if (ts[i]!.string) continue;
    const v = ts[i]!.value;
    if (close.has(v)) stack.push(close.get(v));
    else if (v === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return i + 1;
    }
  }
  return ts.length;
}
