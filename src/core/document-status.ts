import { isDeepStrictEqual } from "node:util";

export type DocumentStatus = "draft" | "stable" | "deprecated";

/** OKF lifecycle is local to the document, independent of Git and material checks. */
export function documentLifecycle(data: Record<string, unknown>): {
  status: DocumentStatus | null;
  statusDiagnostic?: string;
} {
  if (data.status === undefined) return { status: "stable" };
  if (data.status === "draft" || data.status === "stable" || data.status === "deprecated")
    return { status: data.status };
  return {
    status: null,
    statusDiagnostic: "Unsupported document status; preserved without assuming currentness.",
  };
}

/** Unknown declarations can be preserved or explicitly repaired, never silently normalized. */
export function assertStatusEdit(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): void {
  if (!isDeepStrictEqual(before.status, after.status) && documentLifecycle(after).status === null) {
    throw new Error("status must be draft, stable, deprecated, or omitted");
  }
}
