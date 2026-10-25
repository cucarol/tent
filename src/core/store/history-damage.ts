import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";

export class HistoryDamageError extends Error {
  readonly code = "TENT_HISTORY_DAMAGED";
  constructor(
    message: string,
    readonly chooseHead = false,
  ) {
    super(`Tent history: ${message}`);
  }
}

/** The ordinary index is disposable, but damaged bytes need an explicit repair. */
export async function indexDamage(root: string, hashLength?: number): Promise<string | undefined> {
  const bytes = await fs
    .readFile(path.join(root, ".git/index"))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
  if (!bytes) return;
  if (bytes.length && bytes.every((byte) => byte === 0))
    return "zero-filled, likely from an interrupted write";
  if (
    bytes.length < 32 ||
    bytes.toString("ascii", 0, 4) !== "DIRC" ||
    ![2, 3, 4].includes(bytes.readUInt32BE(4))
  )
    return "invalid header";
  for (const length of hashLength ? [hashLength] : [40, 64]) {
    const size = length / 2;
    if (bytes.length < 12 + size) continue;
    const expected = createHash(length === 64 ? "sha256" : "sha1")
      .update(bytes.subarray(0, -size))
      .digest();
    if (bytes.subarray(-size).equals(expected)) return;
  }
  return "checksum mismatch";
}
