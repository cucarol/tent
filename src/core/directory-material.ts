import { createHash } from "node:crypto";
import * as z from "zod/v4";

export const directoryFilesSchema = z
  .array(
    z.object({
      path: z
        .string()
        .min(1)
        .refine(
          (value) =>
            !value.startsWith("/") &&
            !value.includes("\\") &&
            !value
              .split("/")
              .some((part) => part === ".." || part === "." || part === ".git" || !part),
        ),
      version: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  )
  .refine(
    (files) => files.every((file, index) => index === 0 || files[index - 1]!.path < file.path),
    "Directory manifest paths must be ordered and unique",
  );
export type DirectoryFile = z.infer<typeof directoryFilesSchema>[number];

/** Names and normalized content define the basis; empty directories have no members. */
export function directoryFingerprint(files: readonly DirectoryFile[]): string {
  return createHash("sha256")
    .update(JSON.stringify(files.map(({ path, version }) => ({ path, version }))))
    .digest("hex");
}

/** Rename is a deletion and an addition; reports stay bounded even for large trees. */
export function changedDirectoryFiles(
  before: readonly DirectoryFile[],
  after: readonly DirectoryFile[],
) {
  const old = new Map(before.map((file) => [file.path, file.version]));
  const current = new Map(after.map((file) => [file.path, file.version]));
  const changed = [...new Set([...old.keys(), ...current.keys()])]
    .sort()
    .filter((name) => old.get(name) !== current.get(name));
  return {
    changedFiles: changed.slice(0, 20).map((name) => ({
      path: name,
      state: !old.has(name)
        ? ("added" as const)
        : !current.has(name)
          ? ("deleted" as const)
          : ("modified" as const),
    })),
    ...(changed.length > 20 ? { changedFilesOverflow: changed.length - 20 } : {}),
  };
}
