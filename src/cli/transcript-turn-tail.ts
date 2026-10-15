import { open } from "node:fs/promises";

type TurnBoundary = "start" | "same" | "other" | undefined;

/** Read complete JSONL rows backwards until this turn begins, with an 8 MiB I/O cap. */
export async function readTranscriptTurnTail(
  filename: string,
  boundary: (row: unknown) => TurnBoundary,
): Promise<{ lines: string[]; complete: boolean }> {
  const handle = await open(filename, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Transcript is not a file");
    const limit = Math.max(0, stat.size - 8 * 1024 * 1024);
    let position = stat.size;
    let pending: Buffer = Buffer.alloc(0);
    let found = false;
    const reversed: string[] = [];
    while (position > limit) {
      const length = Math.min(256 * 1024, position - limit);
      position -= length;
      const bytes = Buffer.alloc(length);
      const { bytesRead } = await handle.read(bytes, 0, length, position);
      if (bytesRead !== length) throw new Error("Transcript changed while reading");
      const chunk = Buffer.concat([bytes, pending]);
      const firstNewline = position ? chunk.indexOf(10) : -1;
      if (position && firstNewline === -1) {
        pending = chunk;
        continue;
      }
      pending = position ? chunk.subarray(0, firstNewline + 1) : Buffer.alloc(0);
      const lines = chunk
        .subarray(position ? firstNewline + 1 : 0)
        .toString("utf8")
        .split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!;
        if (!line.trim()) continue;
        let marker: TurnBoundary;
        try {
          marker = boundary(JSON.parse(line));
        } catch {
          // Keep malformed rows so the host parser can retain uncertainty.
        }
        if (marker === "other" && found) return { lines: reversed.reverse(), complete: true };
        reversed.push(line);
        if (marker === "start") return { lines: reversed.reverse(), complete: true };
        if (marker === "same") found = true;
      }
    }
    return { lines: reversed.reverse(), complete: position === 0 && found };
  } finally {
    await handle.close();
  }
}
