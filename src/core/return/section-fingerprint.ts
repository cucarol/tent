import { createHash } from "node:crypto";

/** One record per linked Markdown section; Windows paths compare case-insensitively. */
export function sectionKey(workspacePath: string, heading: string): string {
  return JSON.stringify([
    process.platform === "win32" ? workspacePath.toLowerCase() : workspacePath,
    heading,
  ]);
}

/**
 * A linked heading, with the heading line Core's parser found for it at SessionStart.
 * When that line is unknown or gone, the scan falls back to the heading's plain text.
 */
export type SectionTarget = { heading: string; line?: string };
/** A section's fingerprint, and the heading line that selected it, to follow a respelled heading. */
export type SectionPrint = { fingerprint: string; line?: string };

/** The visible text of an ATX heading's inline Markdown, near enough for a fallback match. */
const plainText = (text: string) =>
  text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .trim();

/**
 * The tool hook cannot load the Markdown parser, so it compares a section with itself
 * over time using a line scan: ATX headings outside fenced code. It only detects change;
 * Core's parser stays the authority for what a section contains. One scan serves every
 * linked heading of the file.
 */
export function sectionFingerprints(
  raw: string | undefined,
  targets: readonly SectionTarget[],
): Map<string, SectionPrint> {
  if (raw === undefined)
    return new Map(targets.map(({ heading }) => [heading, { fingerprint: "absent" }]));
  const lines = raw.split("\n");
  let start = 0;
  if (lines[0]?.replace(/\r$/, "") === "---") {
    const close = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\r?$/.test(line));
    if (close > 0) start = close + 1;
  }
  const headings: { line: number; depth: number; raw: string; text: string }[] = [];
  let fence: string | undefined;
  for (let index = start; index < lines.length; index++) {
    const line = lines[index]!.replace(/\r$/, "");
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (
        marker?.[0] === fence[0] &&
        marker.length >= fence.length &&
        /^ {0,3}[`~]+[ \t]*$/.test(line)
      )
        fence = undefined;
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (atx)
      headings.push({
        line: index,
        depth: atx[1]!.length,
        raw: line.trim(),
        text: (atx[2] ?? "").trim(),
      });
  }
  const print = ({ heading, line }: SectionTarget): SectionPrint => {
    const exact =
      line === undefined ? [] : headings.filter((candidate) => candidate.raw === line.trim());
    const matches = exact.length
      ? exact
      : headings.filter(
          (candidate) => candidate.text === heading || plainText(candidate.text) === heading,
        );
    if (matches.length !== 1) return { fingerprint: matches.length ? "ambiguous" : "missing" };
    const selected = matches[0]!;
    const next = headings.find(
      (candidate) => candidate.line > selected.line && candidate.depth <= selected.depth,
    );
    return {
      fingerprint: createHash("sha256")
        .update(lines.slice(selected.line, next?.line).join("\n"))
        .digest("hex"),
      line: selected.raw,
    };
  };
  return new Map(targets.map((target) => [target.heading, print(target)]));
}

export function sectionFingerprint(raw: string | undefined, target: SectionTarget): string {
  return sectionFingerprints(raw, [target]).get(target.heading)!.fingerprint;
}
