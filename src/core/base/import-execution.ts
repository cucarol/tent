type Token = { value: string; kind: string; start?: number; end?: number };

/** Lexical function bodies only: no call graph or evaluation of immediate invocations. */
export function deferredImportTokens(
  tokens: readonly Token[],
  php = false,
  text = "",
): Set<number> {
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== "symbol") continue;
    if (["(", "[", "{"].includes(token.value)) stack.push(i);
    else if ([")", "]", "}"].includes(token.value)) {
      const open = stack.pop();
      if (open !== undefined) {
        pairs.set(open, i);
        pairs.set(i, open);
      }
    }
  }
  const deferred = new Set<number>();
  const mark = (start: number, end: number) => {
    for (let j = start; j <= end; j++) deferred.add(j);
  };
  const endsOperand = (token: Token | undefined) =>
    token !== undefined &&
    (token.kind === "string" ||
      (token.kind === "word" &&
        !["in", "instanceof", "new", "typeof", "void", "delete", "await", "yield"].includes(
          token.value,
        )) ||
      (token.kind === "symbol" && [")", "]", "}"].includes(token.value)));
  const endsExpression = (index: number, start: number) => {
    while (index >= start) {
      const token = tokens[index]!;
      if (token.kind !== "symbol") break;
      if (token.value === "!") {
        // A non-null assertion needs an operand on this line; !=/!== are operators.
        if (
          (tokens[index + 1]?.value === "=" && token.end === tokens[index + 1]?.start) ||
          index === start ||
          /\n/.test(text.slice(tokens[index - 1]?.end, token.start))
        )
          return false;
        index--;
      } else if (
        ["+", "-"].includes(token.value) &&
        tokens[index - 1]?.value === token.value &&
        tokens[index - 1]?.end === token.start
      ) {
        if (
          index - 2 < start ||
          /\n/.test(text.slice(tokens[index - 2]?.end, tokens[index - 1]?.start))
        )
          return false;
        index -= 2;
      } else break;
    }
    return index >= start && endsOperand(tokens[index]);
  };
  const expressionEnd = (start: number) => {
    let end = start;
    for (; end < tokens.length; end++) {
      const token = tokens[end]!;
      const previous = tokens[end - 1];
      if (
        !php &&
        end > start &&
        /\n/.test(text.slice(previous?.end, token.start)) &&
        previous &&
        endsExpression(end - 1, start) &&
        !(
          token.kind === "symbol" &&
          [
            "(",
            "[",
            ".",
            "+",
            "-",
            "*",
            "/",
            "%",
            "&",
            "|",
            "^",
            "?",
            ":",
            "=",
            "<",
            ">",
            "!",
          ].includes(token.value) &&
          (token.value !== "!" ||
            (tokens[end + 1]?.value === "=" && token.end === tokens[end + 1]?.start)) &&
          !(
            ["+", "-"].includes(token.value) &&
            tokens[end + 1]?.value === token.value &&
            token.end === tokens[end + 1]?.start
          )
        ) &&
        !["in", "instanceof"].includes(token.value)
      )
        break;
      if (token.kind !== "symbol") continue;
      if ([",", ";", ")", "]", "}"].includes(token.value)) break;
      if (["(", "[", "{"].includes(token.value)) end = pairs.get(end) ?? end;
    }
    return end - 1;
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (
      token.kind === "word" &&
      (php ? token.value.toLowerCase() : token.value) === "function" &&
      ![".", "->", "::", "\\"].includes(tokens[i - 1]?.value ?? "") &&
      (tokens[i + 1]?.kind === "word" || ["(", "*", "&"].includes(tokens[i + 1]?.value ?? ""))
    ) {
      let params = i + 1;
      while (params < tokens.length && !["(", ";", "{"].includes(tokens[params]!.value)) params++;
      const close = pairs.get(params);
      if (close === undefined) continue;
      let body = close + 1;
      // PHP closure captures and return types, or TypeScript return annotations.
      while (body < tokens.length && !["{", ";", "=>"].includes(tokens[body]!.value)) {
        body = (["(", "["].includes(tokens[body]!.value) ? (pairs.get(body) ?? body) : body) + 1;
      }
      if (tokens[body]?.kind === "symbol" && tokens[body]?.value === "{") {
        mark(params + 1, close);
        mark(body + 1, pairs.get(body) ?? body);
      }
    }
    if (
      !php &&
      token.value === ")" &&
      ["{", ":"].includes(tokens[i + 1]?.value ?? "") &&
      pairs.has(i)
    ) {
      const name = tokens[pairs.get(i)! - 1];
      if (
        name &&
        (["word", "string"].includes(name.kind) ||
          (name.value === "]" && pairs.has(pairs.get(i)! - 1))) &&
        !["if", "for", "while", "switch", "catch", "with"].includes(name.value) &&
        !(name.value === "await" && tokens[pairs.get(i)! - 2]?.value === "for")
      ) {
        let body = i + 1;
        while (body < tokens.length && !["{", ";", "="].includes(tokens[body]!.value)) body++;
        if (tokens[body]?.value === "{") {
          mark(pairs.get(i)! + 1, i);
          mark(body + 1, pairs.get(body) ?? body);
        }
      }
    }
    const arrow = token.value === "=>" || (token.value === "=" && tokens[i + 1]?.value === ">");
    if (!arrow) continue;
    // In PHP only fn introduces an arrow function; => is also an array operator.
    if (php) {
      let before = i - 1;
      while (before >= 0 && ![";", "{", "}", "=>"].includes(tokens[before]!.value)) {
        if (tokens[before]!.value.toLowerCase() === "fn") break;
        before--;
      }
      if (before < 0 || tokens[before]!.value.toLowerCase() !== "fn") continue;
    }
    const start = i + (token.value === "=>" ? 1 : 2);
    let parameters = i - 1;
    if (tokens[parameters]?.value !== ")") {
      // A simple return annotation sits between the parameter list and arrow.
      while (parameters >= 0 && ![":", ";", "{", "}", "="].includes(tokens[parameters]!.value))
        parameters--;
      parameters = tokens[parameters]?.value === ":" ? parameters - 1 : -1;
    }
    if (tokens[parameters]?.value === ")" && pairs.has(parameters))
      mark(pairs.get(parameters)! + 1, parameters);
    mark(
      start,
      tokens[start]?.kind === "symbol" && tokens[start]?.value === "{"
        ? (pairs.get(start) ?? start)
        : expressionEnd(start),
    );
  }
  return deferred;
}
