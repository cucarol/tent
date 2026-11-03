import { parseRoleDocument } from "../store/role-document.js";
import { canonicalIdentityError } from "../store/tree.js";

/** A pinned Node or Role must still pass its own identity rules; null when it does. */
export function cardSourceIdentityError(
  path: string,
  raw: string,
  data: Record<string, unknown>,
): string | null {
  if (path.startsWith("roles/")) {
    try {
      parseRoleDocument(path.slice(6, -3), raw);
      return null;
    } catch {
      return "Selected Role is invalid";
    }
  }
  return canonicalIdentityError(data) ?? null;
}
