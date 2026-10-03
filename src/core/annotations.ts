import * as z from "zod/v4";
import { withTentMutation, type FsAdapter } from "./adapter.js";
import { ANNOTATIONS_PATH } from "./paths.js";
import { isNodeId } from "./id.js";
import { contentEtag } from "./etag.js";
import { canonicalJson } from "./canonical-digest.js";
import { captureDocumentUnlocked } from "./document-history.js";

export type AnnotationDocument = {
  schemaVersion: 1;
  map: {
    elements: Array<Record<string, unknown> & { id: string; type: string }>;
    anchors: Record<string, { node: string; x: number; y: number }>;
  };
};

const documentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  map: z.strictObject({
    elements: z.array(z.looseObject({ id: z.string().min(1), type: z.string() })),
    anchors: z.record(
      z.string(),
      z.strictObject({
        node: z.string().refine(isNodeId),
        x: z.number(),
        y: z.number(),
      }),
    ),
  }),
});

export class AnnotationWriteError extends Error {
  constructor(
    readonly code: "ETAG_CONFLICT" | "INVALID_INPUT",
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AnnotationWriteError";
  }
}

function validateDocument(input: unknown): AnnotationDocument {
  try {
    documentSchema.parse(input);
    z.json().parse(input);
    const document = input as AnnotationDocument;
    const ids = new Set<string>();
    for (const element of document.map.elements) {
      if (ids.has(element.id)) throw new Error(`Duplicate annotation element: ${element.id}`);
      ids.add(element.id);
    }
    return document;
  } catch (error) {
    throw new AnnotationWriteError("INVALID_INPUT", `Invalid annotations: ${String(error)}`);
  }
}

/** Stable keys, preserving paint order; one element/anchor per diff line. */
function serialize(document: AnnotationDocument): string {
  const removed = new Set(
    document.map.elements.filter((e) => e.isDeleted === true).map((e) => e.id),
  );
  const elements = document.map.elements.filter((e) => !removed.has(e.id));
  const anchors = Object.keys(document.map.anchors)
    .filter((id) => !removed.has(id))
    .sort();
  return (
    '{\n  "schemaVersion": 1,\n  "map": {\n    "elements": [' +
    (elements.length
      ? "\n" + elements.map((e) => "      " + canonicalJson(e)).join(",\n") + "\n    "
      : "") +
    '],\n    "anchors": {' +
    (anchors.length
      ? "\n" +
        anchors
          .map(
            (id) => "      " + JSON.stringify(id) + ": " + canonicalJson(document.map.anchors[id]),
          )
          .join(",\n") +
        "\n    "
      : "") +
    "}\n  }\n}\n"
  );
}

async function readRaw(fs: FsAdapter): Promise<string | null> {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      await fs.readBinary(ANNOTATIONS_PATH),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readAnnotations(fs: FsAdapter) {
  const raw = await readRaw(fs);
  if (raw === null) return { etag: null, document: null };
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch (error) {
    throw new AnnotationWriteError("INVALID_INPUT", `Invalid annotations JSON: ${String(error)}`);
  }
  return { etag: contentEtag(raw), document: validateDocument(input) };
}

export function writeAnnotations(
  fs: FsAdapter,
  input: { baseEtag: string | null; document: unknown },
) {
  const raw = serialize(validateDocument(input.document));
  if (input.baseEtag !== null && typeof input.baseEtag !== "string")
    throw new AnnotationWriteError("INVALID_INPUT", "baseEtag must be a string or null");
  return withTentMutation(
    fs,
    async () => {
      const current = await readRaw(fs);
      const currentEtag = current === null ? null : contentEtag(current);
      if (input.baseEtag !== currentEtag)
        throw new AnnotationWriteError("ETAG_CONFLICT", "Annotations changed", {
          currentEtag,
          baseEtag: input.baseEtag,
        });
      // Exact bytes are the ETag basis. A no-op neither writes nor captures.
      if (current === raw) return { etag: contentEtag(raw) };
      await fs.writeFile(ANNOTATIONS_PATH, raw);
      const version = await captureDocumentUnlocked(fs, ANNOTATIONS_PATH, raw, {
        operation: "annotations.write",
      });
      return { etag: contentEtag(raw), ...(version ? { version } : {}) };
    },
    { operation: "annotations.write" },
  );
}
