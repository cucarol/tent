// Shared path-target normalization for Node links / rename rewrite.
// Lives in Core so rename-ops does not create a reverse dependency on markdown.
import path from "node:path";

/** Decode %XX sequences when well-formed; leave raw on failure. */
function safePercentDecode(value: string): string {
  try {
    if (!/%[0-9A-Fa-f]{2}/.test(value)) return value;
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Normalize a link destination for Node resolution / path rewrite.
 * Strips angle brackets, query/fragment, optional `.md`, and resolves `./` `../`
 * against the authoring note path when present.
 */
export function normalizeTarget(raw: string, fromNotePath?: string): string {
  return resolveTargetPath(raw, fromNotePath).replace(/\.md$/i, "");
}

/** Resolve a destination while retaining its complete decoded filename. */
export function resolveTargetPath(raw: string, fromNotePath?: string): string {
  let t = raw.trim().replace(/\\/g, "/");
  if (t.startsWith("<") && t.endsWith(">")) t = t.slice(1, -1).trim();
  t = (t.split("#")[0]?.split("?")[0] ?? t).trim();
  t = safePercentDecode(t);

  if ((t.startsWith("./") || t.startsWith("../")) && fromNotePath) {
    const ownerDir = path.posix.dirname(fromNotePath.replace(/\\/g, "/"));
    t = path.posix.join(ownerDir, t);
    // A workspace-relative alias may leave .tent and enter that same bundle again.
    if (t === "../.tent") t = ".";
    else if (t.startsWith("../.tent/")) t = t.slice("../.tent/".length);
  }
  return t.replace(/^\//, "");
}
