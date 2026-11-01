/** Exact Markdown frontmatter boundaries, shared by YAML readers and prepared Hook reads. */
export function frontmatterBoundary(
  raw: string,
): { opening: RegExpExecArray; closing: RegExpExecArray | null } | undefined {
  const opening = /^(\uFEFF)?---[\t ]*(\r?\n)/.exec(raw);
  if (!opening) return;
  const fence = /^---[\t ]*(?:\r?\n|$)/gm;
  fence.lastIndex = opening[0].length;
  return { opening, closing: fence.exec(raw) };
}
