import path from "node:path";
import { stat } from "node:fs/promises";
import {
  materialFields,
  materialLocator,
  localMaterialPath,
  isCardResponseSource,
  type MaterialSource,
} from "../core/material.js";
import { isNodeId } from "../core/id.js";

/** CLI file declarations use the Workspace root; serialized documents use Core addresses. */
export async function workspaceMaterialFields(
  data: Record<string, unknown>,
  documentPath: string,
  workspaceRoot: string,
  previous: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const fields = materialFields(data);
  const retainedSources = new Map<string, number>();
  for (const source of materialFields(previous).sources ?? [])
    retainedSources.set(source.resource, (retainedSources.get(source.resource) ?? 0) + 1);
  async function address(resource: string, source = false): Promise<string> {
    if (!source && resource === previous.resource) return resource;
    if (source) {
      const retained = retainedSources.get(resource) ?? 0;
      if (retained) {
        retainedSources.set(resource, retained - 1);
        return resource;
      }
    }
    const value = resource.trim();
    if (source && value.startsWith("/cards/") && isCardResponseSource(value, documentPath))
      return resource;
    if (value.startsWith("//")) materialLocator(value, "index.md");
    const target = value.split(/[?#]/, 1)[0]!;
    if (isNodeId(target) || target.startsWith("@") || /^[a-z][a-z\d+.-]*:/i.test(value))
      return resource;
    const explicit = /^(?:\.{1,2}\/|\/)/.test(value);
    let locator;
    try {
      locator = materialLocator(`../${value.replace(/^\//, "")}`, "index.md");
    } catch (error) {
      if (source && !explicit) return resource;
      throw error;
    }
    if (locator.kind !== "path") return resource;
    if (source && !explicit) {
      const filename = localMaterialPath(locator, workspaceRoot)!;
      try {
        if (!(await stat(filename)).isFile()) return resource;
      } catch (error) {
        if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
          return resource;
        throw error;
      }
    }
    const relative = path.posix.relative(path.posix.dirname(documentPath), locator.target);
    const encoded = relative.split("/").map(encodeURIComponent).join("/");
    return (encoded.startsWith("../") ? encoded : `./${encoded}`) + locator.suffix;
  }
  return {
    ...data,
    ...(fields.resource === undefined ? {} : { resource: await address(fields.resource) }),
    ...(fields.sources === undefined
      ? {}
      : {
          sources: await Promise.all(
            fields.sources.map(async (source) => ({
              ...source,
              resource: await address(source.resource, true),
            })),
          ),
        }),
  };
}

/**
 * Core link-output reads bare paths from the Workspace root and `/` from `.tent`.
 * Convert an address serialized for `.tent/index.md` into that convention.
 */
export function linkOutputResource(address: string): string {
  if (address.startsWith("../")) return address.slice(3);
  if (address.startsWith("./")) return `/${address.slice(2)}`;
  return address;
}

/** Explicit CLI path sources (`./`, `/`, `.tent/`) that name no existing file, Node or Role. */
export async function missingExplicitSources(
  input: readonly MaterialSource[],
  stored: readonly MaterialSource[],
  documentPath: string,
  workspaceRoot: string,
): Promise<string[]> {
  const warnings: string[] = [];
  for (const [index, source] of input.entries()) {
    const value = source.resource.trim();
    if (source.version !== undefined || !/^(?:\.\/|\/|\.tent\/)/.test(value)) continue;
    const address = stored[index]!.resource;
    let filename: string | undefined;
    try {
      filename = localMaterialPath(materialLocator(address, documentPath, true), workspaceRoot);
    } catch {
      continue;
    }
    if (filename && (await isFile(filename))) continue;
    warnings.push(
      `Warning: source ${JSON.stringify(source.resource)} names no existing Workspace file, Node or Role; the Card keeps it as ${JSON.stringify(address)}.`,
    );
  }
  return warnings;
}

export async function isFile(filename: string): Promise<boolean> {
  try {
    return (await stat(filename)).isFile();
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}
