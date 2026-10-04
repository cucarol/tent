import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessionFileObservationSchema } from "../core/session-observations.js";
import { observeSourceFile } from "./source-observation.js";

/** Stream local bytes only; explicit outside-workspace addresses use file: URIs. */
export async function observeSessionFile(workspaceRoot: string, address: string) {
  sessionFileObservationSchema.parse({ kind: "read", address });
  const filename = address.startsWith("file:")
    ? fileURLToPath(address)
    : path.resolve(workspaceRoot, address);
  return observeSourceFile(
    address.startsWith("file:") ? path.parse(filename).root : path.resolve(workspaceRoot),
    filename,
  );
}
