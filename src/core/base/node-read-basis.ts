const incompleteReadPrefix = "read:";

/** An incomplete Node read identifies a revision without supplying a body replacement basis. */
export function incompleteNodeReadEtag(etag: string): string {
  return isIncompleteNodeReadEtag(etag) ? etag : incompleteReadPrefix + etag;
}

export function isIncompleteNodeReadEtag(etag: string): boolean {
  return etag.startsWith(incompleteReadPrefix);
}

/** Continuation reads and metadata-only edits still compare the exact document revision. */
export function nodeReadRevisionEtag(etag: string): string {
  return isIncompleteNodeReadEtag(etag) ? etag.slice(incompleteReadPrefix.length) : etag;
}
