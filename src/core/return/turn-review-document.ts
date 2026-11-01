import { sha256Hex } from "../base/canonical-digest.js";
import { frontmatterBoundary } from "../base/frontmatter-boundary.js";

/** Split only an already-indexed header; live bytes must match its prepared digest. */
export function turnReviewDocument(raw: string): { header: string; body: string } {
  const boundary = frontmatterBoundary(raw);
  if (!boundary) throw new Error("Node frontmatter is missing");
  const { closing } = boundary;
  if (!closing) throw new Error("Node frontmatter is unterminated");
  const end = closing.index + closing[0].length;
  return { header: raw.slice(0, end), body: raw.slice(end) };
}

export const turnReviewHeaderDigest = sha256Hex;
