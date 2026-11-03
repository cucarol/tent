import { hasDocumentHistory } from "../store/history-port.js";
import { createHash } from "node:crypto";
import { type FsAdapter, type DocumentHeaderObservation } from "../store/adapter.js";

/** One read's exact byte comparison; no capture, baseline update or cache write. */
export async function uncapturedChecker(fs: FsAdapter) {
  const blobs =
    fs.history && (await hasDocumentHistory(fs))
      ? await fs.history.documentBlobs()
      : new Map<string, string>();
  return (path: string, raw: string | Pick<DocumentHeaderObservation, "fingerprint">): boolean => {
    const blob = blobs.get(path);
    if (!blob) return true;
    if (typeof raw !== "string") return raw.fingerprint !== blob;
    const bytes = Buffer.from(raw, "utf8");
    return (
      createHash(blob.length === 64 ? "sha256" : "sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex") !== blob
    );
  };
}
