import {
  Document,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  Scalar,
  visit,
  type Node as YamlNode,
} from "yaml";

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
  /** Original top-level key order, retained when serializing. */
  keyOrder: string[];
}

export const NODE_FRONTMATTER_KEY_ORDER = ["id", "type", "tags", "status"];

/** Keep an explicitly stored Node title in sync with its identity filename. */
export function syncNodeTitle(data: Record<string, unknown>, nodePath: string): void {
  if (data.title !== undefined) data.title = nodePath.slice(nodePath.lastIndexOf("/") + 1);
}

type Source = { document: Document; prefix: string; eol: string; bom: string; keys: string[] };
// keyOrder carries the original document through callers that shallow-copy data.
const sources = new WeakMap<object, Source>();

export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const opening = /^(\uFEFF)?---[\t ]*(\r?\n)/.exec(raw);
  if (!opening) return { data: {}, body: raw, keyOrder: [] };
  const fence = /^---[\t ]*(?:\r?\n|$)/gm;
  fence.lastIndex = opening[0].length;
  const closing = fence.exec(raw);
  if (!closing) throw invalidYaml("unterminated frontmatter fence.");

  const { document, data } = readYaml(raw.slice(opening[0].length, closing.index));
  const keyOrder = isMap(document.contents)
    ? document.contents.items.map((pair) => String((pair.key as Scalar).value))
    : [];
  const end = closing.index + closing[0].length;
  const source = {
    document,
    prefix: raw.slice(0, end),
    eol: opening[2],
    bom: opening[1] ?? "",
    keys: keyOrder.slice(),
  };
  sources.set(data, source);
  sources.set(keyOrder, source);
  return { data, body: raw.slice(end), keyOrder };
}

function readYaml(text: string): { document: Document; data: Record<string, unknown> } {
  try {
    const document = parseDocument(text, {
      version: "1.2",
      schema: "core",
      resolveKnownTags: false,
      intAsBigInt: true,
      uniqueKeys: true,
      strict: true,
      logLevel: "silent",
    });
    const issue =
      document.errors.find((error) => error.code === "MISSING_CHAR") ??
      document.errors[0] ??
      document.warnings[0];
    if (issue) {
      const detail = /end with a \}/.test(issue.message)
        ? "unterminated flow mapping. "
        : /end with a \]/.test(issue.message)
          ? "unterminated flow array. "
          : issue.code === "DUPLICATE_KEY"
            ? "duplicate mapping key. "
            : "";
      throw invalidYaml(detail + issue.message);
    }
    if (document.contents !== null && !isMap(document.contents)) {
      throw invalidYaml("frontmatter must be a mapping with string keys.");
    }
    visit(document, {
      Pair(_key, pair) {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
          throw invalidYaml("mapping keys must be strings; complex or typed keys are unsupported.");
        }
      },
      Scalar(_key, scalar) {
        if (typeof scalar.value === "bigint") {
          const number = Number(scalar.value);
          if (!Number.isFinite(number) || BigInt(number) !== scalar.value) {
            throw invalidYaml(
              "integer cannot be represented exactly; quote it to preserve its digits.",
            );
          }
          scalar.value = scalar.source === "-0" ? -0 : number;
        }
      },
    });
    const data = document.toJS({ maxAliasCount: 100 }) ?? {};
    assertJsonValue(data);
    return { document, data };
  } catch (error) {
    throw invalidYaml(error instanceof Error ? error.message : String(error));
  }
}

/** Serialize JSON-compatible metadata; undefined object properties remove declarations. */
export function serializeFrontmatter(
  data: Record<string, unknown>,
  body: string,
  keyOrder: string[] = [],
): string {
  assertJsonValue(data);
  const keys = orderedKeys(data, keyOrder);
  const source = sources.get(data) ?? sources.get(keyOrder);
  const original = source?.document.toJS({ maxAliasCount: 100 }) ?? {};
  if (source && sameValue(keys, source.keys) && sameValue(data, original)) {
    return source.prefix + (body && !source.prefix.endsWith("\n") ? source.eol : "") + body;
  }

  const document = source?.document.clone() ?? new Document({});
  if (!isMap(document.contents)) document.contents = document.createNode({});
  const mapping = document.contents;
  if (!isMap(mapping)) throw invalidYaml("frontmatter must be a mapping.");
  for (const pair of mapping.items.slice()) {
    const key = String((pair.key as Scalar).value);
    if (!keys.includes(key)) document.delete(key);
  }
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(original, key) && sameValue(data[key], original[key]))
      continue;
    const previous = document.get(key, true);
    const next = createValue(document, data[key]);
    if (isNode(previous)) {
      next.comment = previous.comment;
      next.commentBefore = previous.commentBefore;
      next.spaceBefore = previous.spaceBefore;
    }
    document.set(key, next);
  }
  const positions = new Map(keys.map((key, index) => [key, index]));
  mapping.items.sort(
    (left, right) =>
      positions.get(String((left.key as Scalar).value))! -
      positions.get(String((right.key as Scalar).value))!,
  );

  try {
    const eol = source?.eol ?? "\n";
    const yaml =
      !source && keys.length === 0
        ? ""
        : document.toString({
            lineWidth: 0,
            blockQuote: false,
            doubleQuotedAsJSON: true,
            flowCollectionPadding: false,
          });
    const result = `${source?.bom ?? ""}---${eol}${yaml.replace(/\n/g, eol)}---${eol}${body}`;
    // Replacing an anchor must not silently change a retained alias.
    if (!sameValue(data, parseFrontmatter(result).data)) {
      throw invalidYaml("update cannot preserve metadata values; refusing to rewrite it.");
    }
    return result;
  } catch (error) {
    throw invalidYaml(error instanceof Error ? error.message : String(error));
  }
}

function createValue(document: Document, value: unknown): YamlNode {
  const node = document.createNode(value, { flow: true, aliasDuplicateObjects: false });
  if (isSeq(node) && Array.isArray(value) && value.some(isRecord)) node.flow = false;
  visit(node, {
    Scalar(_key, scalar) {
      if (
        typeof scalar.value === "string" &&
        /[:,#\[\]{}\u0000-\u001f\u007f-\u009f]/.test(scalar.value)
      ) {
        scalar.type = Scalar.QUOTE_DOUBLE;
      }
    },
  });
  return node;
}

function orderedKeys(data: Record<string, unknown>, keyOrder: string[]): string[] {
  return [...new Set([...keyOrder, ...Object.keys(data)])].filter(
    (key) => Object.prototype.hasOwnProperty.call(data, key) && data[key] !== undefined,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

function assertJsonValue(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!Array.isArray(value) && !isRecord(value)) {
    throw invalidYaml(
      "unsupported metadata value; expected JSON-compatible scalars, arrays or mappings.",
    );
  }
  if (ancestors.has(value)) throw invalidYaml("cyclic metadata aliases are unsupported.");
  ancestors.add(value);
  for (const item of Array.isArray(value)
    ? value
    : Object.values(value).filter((item) => item !== undefined)) {
    assertJsonValue(item, ancestors);
  }
  ancestors.delete(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((item, index) => sameValue(item, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  return (
    keys.length === Object.keys(right).filter((key) => right[key] !== undefined).length &&
    keys.every(
      (key) => Object.prototype.hasOwnProperty.call(right, key) && sameValue(left[key], right[key]),
    )
  );
}

function invalidYaml(message: string): Error {
  return new Error(
    message.startsWith("Invalid frontmatter YAML:")
      ? message
      : `Invalid frontmatter YAML: ${message}`,
  );
}
