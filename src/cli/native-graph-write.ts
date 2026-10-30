import path from "node:path";
import { isHookGraphFile } from "../core/base/paths.js";

/** Cheap admission only; the authoritative export rechecks actual checkout/root routing. */
export function hasNativeGraphWrite(cwd: string, files: readonly string[]): boolean {
  return files.some((file) =>
    [file, path.resolve(cwd, file)].some((candidate) => {
      const parts = candidate.replace(/\\/g, "/").split("/");
      return parts.some(
        (part, index) =>
          (process.platform === "win32" ? part.toLowerCase() : part) === ".tent" &&
          isHookGraphFile(
            process.platform === "win32"
              ? parts
                  .slice(index + 1)
                  .join("/")
                  .toLowerCase()
              : parts.slice(index + 1).join("/"),
          ),
      );
    }),
  );
}

/** Reuse the existing CLI artifact only for known graph writes; ordinary hooks never import it. */
export async function refreshNativeGraphWrite(
  host: "codex" | "claude-code",
  cwd: string,
  files: readonly string[],
): Promise<boolean> {
  if (!hasNativeGraphWrite(cwd, files)) return true;
  const entry = new URL(
    import.meta.url.endsWith(".ts") ? "./tent.ts" : "./cli.mjs",
    import.meta.url,
  );
  const { refreshNativeHookIndex } = await import(entry.href);
  return refreshNativeHookIndex(host, cwd, files);
}
