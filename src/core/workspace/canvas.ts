import { hasDocumentHistory } from "../store/history-port.js";
import * as z from "zod/v4";
import { withTentMutation, type FsAdapter } from "../store/adapter.js";
import { contentEtag } from "../base/etag.js";
import { isNodeId } from "../base/id.js";
import { CANVAS_PATH } from "../base/paths.js";

export const CANVAS_LIMIT = 5 * 1024 * 1024;
const nodeId = z.string().refine(isNodeId);
const distinct = (ids: readonly string[]) => new Set(ids).size === ids.length;
const nodeIds = z.array(nodeId).refine(distinct);
// The map lays every topic out itself; the file keeps folds and opaque UI drawings.
const canvasSchema = z
  .strictObject({
    version: z.literal(3),
    open: nodeIds,
    shut: nodeIds,
    drawings: z.array(
      z
        .looseObject({ id: z.string(), kind: z.enum(["pen", "text", "shape"]) })
        .refine((drawing) => !Object.prototype.hasOwnProperty.call(drawing, "node")),
    ),
  })
  .refine((canvas) => !canvas.open.some((id) => canvas.shut.includes(id)));
export type Canvas = z.infer<typeof canvasSchema>;
export type CanvasDocument = { etag: string; canvas: Canvas } | { etag: null; canvas: null };
/** An unreadable file exposes its existing CAS identity, never its invalid contents. */
export type CanvasCurrent = CanvasDocument | { etag: string };

export class CanvasError extends Error {
  constructor(
    readonly code: "INVALID_INPUT" | "ETAG_CONFLICT",
    message: string,
    readonly details?: { current: CanvasCurrent },
  ) {
    super(message);
    this.name = "CanvasError";
  }
}

function validate(value: unknown): Canvas {
  const result = canvasSchema.safeParse(value);
  if (!result.success) throw new CanvasError("INVALID_INPUT", "Invalid canvas structure");
  return result.data;
}

function checkSize(raw: string) {
  if (Buffer.byteLength(raw, "utf8") > CANVAS_LIMIT)
    throw new CanvasError("INVALID_INPUT", "Canvas exceeds 5 MiB");
}

async function readRaw(fs: FsAdapter): Promise<string | null> {
  try {
    return await fs.readFile(CANVAS_PATH);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function document(raw: string | null): CanvasDocument {
  if (raw === null) return { etag: null, canvas: null };
  try {
    checkSize(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CanvasError("INVALID_INPUT", "canvas.json is not valid JSON");
    }
    return { etag: contentEtag(raw), canvas: validate(parsed) };
  } catch (error) {
    if (!(error instanceof CanvasError)) throw error;
    throw new CanvasError(error.code, error.message, { current: { etag: contentEtag(raw) } });
  }
}

/** Reads never create, repair, prune, or capture the UI's layout file. */
export async function readCanvasDocument(fs: FsAdapter): Promise<CanvasDocument> {
  return document(await readRaw(fs));
}

/** The shared workspace lock covers whole-file CAS, preimage capture, and the saved version. */
export function writeCanvasDocument(fs: FsAdapter, input: { baseEtag: unknown; canvas: unknown }) {
  if (input.baseEtag !== null && typeof input.baseEtag !== "string")
    throw new CanvasError("INVALID_INPUT", "baseEtag must be text or null");
  const canvas = validate(input.canvas);
  const raw = JSON.stringify(canvas) + "\n";
  checkSize(raw);
  return withTentMutation(
    fs,
    async () => {
      const before = await readRaw(fs);
      const etag = before === null ? null : contentEtag(before);
      if (input.baseEtag !== etag) {
        let current: CanvasCurrent;
        try {
          current = document(before);
        } catch (error) {
          if (!(error instanceof CanvasError) || error.code !== "INVALID_INPUT") throw error;
          current = { etag: etag! };
        }
        throw new CanvasError("ETAG_CONFLICT", "Canvas changed; reread before saving", { current });
      }
      if (raw !== before) await fs.writeFile(CANVAS_PATH, raw);
      const version =
        fs.history && (await hasDocumentHistory(fs))
          ? (
              await fs.history.captureUnlocked([{ path: CANVAS_PATH, raw }], {
                operation: "canvas.write",
              })
            ).versions[0]
          : undefined;
      return { etag: contentEtag(raw), ...(version ? { version } : {}) };
    },
    { operation: "canvas.write" },
  );
}
