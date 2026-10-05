import path from "node:path";
import type { MaterialLocator } from "./material.js";
import { selectSection } from "./markdown-section.js";
import { parseFrontmatter } from "./frontmatter.js";

/** Local Markdown fragments name literal heading text, never generated anchor slugs. */
export function markdownMaterialHeading(locator: MaterialLocator): string | undefined {
  let filename: string, fragment: string;
  if (locator.kind === "path") {
    filename = locator.target;
    const hash = locator.suffix.indexOf("#");
    fragment = hash < 0 ? "" : locator.suffix.slice(hash + 1);
  } else if (locator.kind === "uri" && locator.uri.startsWith("file:")) {
    const uri = new URL(locator.uri);
    filename = decodeURIComponent(uri.pathname);
    fragment = uri.hash.slice(1);
  } else return undefined;
  if (!/\.(?:md|markdown)$/i.test(path.posix.extname(filename))) return undefined;
  const heading = decodeURIComponent(fragment).trim();
  if (!heading) return undefined;
  if (/[\r\n]/.test(heading)) throw new Error("heading must be nonempty single-line text");
  return heading;
}

/** The same selected bytes are used for disk observations and final atomic-save documents. */
export function materialContent(raw: string, locator: MaterialLocator): string {
  const heading = markdownMaterialHeading(locator);
  return heading === undefined ? raw : selectSection(parseFrontmatter(raw).body, heading).text;
}
