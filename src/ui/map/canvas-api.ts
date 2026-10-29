import { api, ApiError, describe } from "../data/api.js";
import { canvasBase, type CanvasInitial } from "./canvas.js";

/** Only Core's rejected-content response permits the default view, not transport or I/O failures. */
export async function loadCanvas(): Promise<CanvasInitial> {
  try {
    return canvasBase(await api.canvas());
  } catch (error) {
    if (error instanceof ApiError && error.status === 422 && error.code === "INVALID_INPUT") {
      const current = error.details?.current as { etag?: unknown; canvas?: unknown } | undefined;
      if (current && typeof current.etag === "string" && !("canvas" in current))
        return canvasBase({ etag: current.etag });
    }
    return { error: describe(error) };
  }
}
