import path from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod/v4";
import { isCardId } from "./id.js";

// Keep user spelling and source order; these declarations are not a set of URLs.
export const resourceSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "Resource must not be empty");
export const sourceSchema = z.looseObject({ resource: resourceSchema });
export const sourcesSchema = z.array(sourceSchema);
export type MaterialSource = z.infer<typeof sourceSchema>;
export type MaterialFields = { resource?: string; sources?: MaterialSource[] };

export function materialFields(data: Record<string, unknown>): MaterialFields {
  if (data.sources !== undefined) parseField(sourcesSchema, "sources", data.sources);
  return {
    ...(data.resource === undefined
      ? {}
      : { resource: parseField(resourceSchema, "resource", data.resource) }),
    // Validate shape without using a parser projection that may drop unknown
    // own keys such as __proto__. Parsed Markdown/RPC data is already JSON-safe.
    ...(data.sources === undefined ? {} : { sources: data.sources as MaterialSource[] }),
  };
}

/** Standalone field validation keeps the field name at the start of each issue path. */
function parseField<T>(schema: z.ZodType<T>, field: string, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new z.ZodRealError(
    result.error.issues.map((issue) => ({ ...issue, path: [field, ...issue.path] })),
  );
}

export function materialOccurrences(data: Record<string, unknown>) {
  const fields = materialFields(data);
  const occurrences: Array<{ field: "resource" | "sources"; index?: number; resource: string }> =
    [];
  if (fields.resource !== undefined)
    occurrences.push({ field: "resource", resource: fields.resource });
  fields.sources?.forEach((source, index) =>
    occurrences.push({ field: "sources", index, resource: source.resource }),
  );
  return occurrences;
}

/** A Card source records the output's response relationship, never material content. */
export function isCardResponseSource(resource: string, documentPath: string): boolean {
  try {
    const locator = materialLocator(resource, documentPath, true);
    if (locator.kind !== "path" || isDirectoryMaterial(locator)) return false;
    const match = /^cards\/(card-[^/]+)\.md$/.exec(locator.target);
    return !!match && isCardId(match[1]!);
  } catch {
    return false;
  }
}

export class MaterialAddressError extends Error {}

/** Validate new addresses; retained source occurrences may move or change metadata. */
export function validateMaterialAddresses(
  data: Record<string, unknown>,
  documentPath: string,
  previous?: Record<string, unknown>,
): void {
  const retainedSources = new Map<string, number>();
  for (const source of materialFields(previous ?? {}).sources ?? [])
    retainedSources.set(source.resource, (retainedSources.get(source.resource) ?? 0) + 1);
  for (const occurrence of materialOccurrences(data)) {
    if (occurrence.field === "resource" && occurrence.resource === previous?.resource) continue;
    if (occurrence.field === "sources") {
      const retained = retainedSources.get(occurrence.resource) ?? 0;
      if (retained) {
        retainedSources.set(occurrence.resource, retained - 1);
        continue;
      }
    }
    try {
      materialLocator(occurrence.resource, documentPath, occurrence.field === "sources");
    } catch (error) {
      const field =
        occurrence.field === "resource" ? "resource" : `sources[${occurrence.index}].resource`;
      throw new MaterialAddressError(
        `Invalid ${field}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export type MaterialLocator =
  | {
      kind: "path";
      anchor: "bundle" | "document";
      target: string;
      suffix: string;
      directory?: true;
    }
  | { kind: "uri"; uri: string }
  | { kind: "unresolved"; text: string };

/** Each declaration keeps its occurrence address, even when it cannot be resolved. */
export function resolvedMaterialOccurrences(
  data: Record<string, unknown>,
  documentPath: string,
): Array<
  ReturnType<typeof materialOccurrences>[number] & { locator?: MaterialLocator; error?: string }
> {
  return materialOccurrences(data).map((occurrence) => {
    try {
      return {
        ...occurrence,
        locator: materialLocator(occurrence.resource, documentPath, occurrence.field === "sources"),
      };
    } catch (error) {
      return { ...occurrence, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

export function materialIdentity(locator: MaterialLocator): string | undefined {
  return locator.kind === "path"
    ? JSON.stringify([
        "path",
        locator.target + (locator.directory && !locator.target.endsWith("/") ? "/" : ""),
        locator.suffix,
      ])
    : locator.kind === "uri"
      ? JSON.stringify(["uri", locator.uri])
      : undefined;
}

/** Pure resolution in the .tent-relative namespace; never consult cwd or a Session. */
export function materialLocator(
  resource: string,
  documentPath: string,
  source = false,
): MaterialLocator {
  resourceSchema.parse(resource);
  const value = resource.trim();
  const explicitPath = /^(?:\.{1,2}\/|\/)/.test(value);
  const explicitUri = /^[a-z][a-z\d+.-]*:\S/i.test(value) && !/\s/.test(value);
  // A source may name a population rather than a file. Do not guess based on
  // extensions, whitespace, or whether a similarly named file exists today.
  if (source && !explicitPath && !explicitUri) {
    return { kind: "unresolved", text: resource };
  }
  if (
    value.includes("\0") ||
    /^[a-z]:[\\/]/i.test(value) ||
    value.startsWith("\\\\") ||
    value.startsWith("//")
  ) {
    throw new Error(
      "Local material paths use / separators; absolute filesystem paths require a file: URI",
    );
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) {
    const uri = new URL(value);
    if (uri.protocol === "file:" && uri.pathname.endsWith("/") && (uri.search || uri.hash))
      throw new Error("Directory materials cannot select a query or fragment");
    return { kind: "uri", uri: uri.href };
  }
  if (value.includes("\\")) throw new Error("Local material paths use / separators");
  if (
    !documentPath ||
    path.posix.isAbsolute(documentPath) ||
    documentPath.split("/").includes("..")
  ) {
    throw new Error("Material owner must be a document path inside .tent");
  }
  const split = value.search(/[?#]/);
  const suffix = split < 0 ? "" : value.slice(split);
  const encoded = split < 0 ? value : value.slice(0, split);
  const decoded = decodeURIComponent(encoded);
  const directory = decoded.endsWith("/");
  if (directory && suffix) throw new Error("Directory materials cannot select a query or fragment");
  if (!decoded || decoded.includes("\0") || decoded.includes("\\") || decoded.startsWith("//"))
    throw new Error("Invalid material path");
  const anchor = value.startsWith("/") ? "bundle" : "document";
  let target = path.posix.normalize(
    anchor === "bundle"
      ? decoded.slice(1)
      : path.posix.join(path.posix.dirname(documentPath), decoded),
  );
  if (anchor === "bundle" && (target === ".." || target.startsWith("../"))) {
    let suggestion = "";
    if (target !== "../.." && !target.startsWith("../../")) {
      const relative = path.posix.relative(
        path.posix.join("/.tent", path.posix.dirname(documentPath)),
        path.posix.join("/.tent", target),
      );
      const address =
        (relative.startsWith("../") ? relative : `./${relative}`)
          .split("/")
          .map(encodeURIComponent)
          .join("/") + suffix;
      suggestion = `; use ${JSON.stringify(address)} relative to the declaring Node file`;
    }
    throw new Error(`Bundle material path escapes .tent${suggestion}`);
  }
  if (target === "../.." || target.startsWith("../../"))
    throw new Error("Material outside the Workspace requires an absolute URI");
  // A relative path may leave .tent and re-enter it (../../.tent/A/A.md).
  // Canonicalize that alias in a synthetic Workspace, never against process.cwd.
  target = path.posix.relative("/.tent", path.posix.join("/.tent", target)) || ".";
  if (/^[a-z]:/i.test(target)) throw new Error("Absolute filesystem paths require a file: URI");
  if (directory) return { kind: "path", anchor, target, suffix, directory: true };
  return { kind: "path", anchor, target, suffix };
}

/** A trailing slash declares recursive directory material, including file: addresses. */
export function isDirectoryMaterial(locator: MaterialLocator): boolean {
  return locator.kind === "path"
    ? locator.directory === true
    : locator.kind === "uri" &&
        locator.uri.startsWith("file:") &&
        new URL(locator.uri).pathname.endsWith("/");
}

/** Convert a known local locator to a host path. Other URI schemes remain references. */
export function localMaterialPath(
  locator: MaterialLocator,
  workspaceRoot: string,
): string | undefined {
  if (locator.kind === "unresolved") return undefined;
  if (locator.kind === "uri")
    return locator.uri.startsWith("file:") ? fileURLToPath(locator.uri) : undefined;
  const filename = path.resolve(workspaceRoot, ".tent", locator.target);
  const boundary =
    locator.anchor === "bundle" ? path.resolve(workspaceRoot, ".tent") : workspaceRoot;
  const relative = path.relative(boundary, filename);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("Material path escapes its root");
  return filename;
}

/** Update current descriptors only. Historical Card/retained bytes never enter this path. */
export function rewriteMaterialPaths(
  data: Record<string, unknown>,
  fromDocument: string,
  toDocument: string,
  moves: ReadonlyMap<string, string>,
): boolean {
  let changed = false;
  const directories = [...moves.keys()].sort((a, b) => b.length - a.length);
  const movedTarget = (target: string) => {
    const from = directories.find((old) => target === old || target.startsWith(`${old}/`));
    return from === undefined ? target : moves.get(from)! + target.slice(from.length);
  };
  for (const occurrence of materialOccurrences(data)) {
    const locator = materialLocator(
      occurrence.resource,
      fromDocument,
      occurrence.field === "sources",
    );
    if (locator.kind === "unresolved") {
      // Hypothetical path arithmetic detects an affected ambiguity; it does not
      // turn an unknown source into a file reference or inspect the filesystem.
      let before: MaterialLocator;
      try {
        before = materialLocator(occurrence.resource, fromDocument);
      } catch {
        continue;
      } // Not a supported path even under that hypothesis.
      let after: MaterialLocator | undefined;
      try {
        after = materialLocator(occurrence.resource, toDocument);
      } catch {
        /* A new out-of-bounds location also changes meaning. */
      }
      if (
        before.kind === "path" &&
        (after?.kind !== "path" || movedTarget(before.target) !== after.target)
      ) {
        const shown = occurrence.resource.slice(0, 256);
        throw new Error(
          `Unresolved source may change target during move: ${fromDocument} sources[${occurrence.index}].resource = ${JSON.stringify(shown)}${shown.length < occurrence.resource.length ? " (truncated)" : ""}. Clarify this source before moving.`,
        );
      }
      continue;
    }
    if (locator.kind !== "path") continue;
    const target = movedTarget(locator.target);
    // Keep original bytes when both endpoints have the same relation.
    const baseBefore = path.posix.dirname(fromDocument);
    const baseAfter = path.posix.dirname(toDocument);
    if (target === locator.target && (locator.anchor === "bundle" || baseBefore === baseAfter))
      continue;
    try {
      const unchanged = materialLocator(
        occurrence.resource,
        toDocument,
        occurrence.field === "sources",
      );
      if (unchanged.kind === "path" && unchanged.target === target) continue;
    } catch {
      /* Restyle a reference that becomes invalid at its new declaration path. */
    }
    let address =
      locator.anchor === "bundle"
        ? `/${target === "." ? "" : target}`
        : path.posix.relative(
            path.posix.join("/.tent", baseAfter),
            path.posix.join("/.tent", target),
          ) || ".";
    if (locator.anchor === "document" && !address.startsWith("../")) address = `./${address}`;
    // Preserve encoded style when present, and always protect URI delimiters.
    address = /%[\da-f]{2}/i.test(occurrence.resource)
      ? address.split("/").map(encodeURIComponent).join("/")
      : address.replace(/[%?#]/g, (character) => encodeURIComponent(character));
    const next =
      address + (locator.directory && !address.endsWith("/") ? "/" : "") + locator.suffix;
    if (next === occurrence.resource) continue;
    if (occurrence.field === "resource") data.resource = next;
    else {
      // YAML aliases may share this array with unknown metadata. Detach the
      // field before changing an occurrence; the serializer verifies aliases.
      const sources = [...(data.sources as MaterialSource[])];
      sources[occurrence.index!] = { ...sources[occurrence.index!], resource: next };
      data.sources = sources;
    }
    changed = true;
  }
  return changed;
}
