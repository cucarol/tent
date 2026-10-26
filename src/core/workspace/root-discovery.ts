import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { linkedMainCheckout, readGitCheckout } from "./git-checkout.js";

export type TentRootProbe = (root: string) => Promise<boolean>;
export type RejectedRootMarker = { root: string; digest: string };
/** Byte identity only; marker interpretation belongs to the complete Core parser. */
export const rootMarkerDigest = (raw: Uint8Array) => createHash("sha256").update(raw).digest("hex");

/** Shared checkout/root routing; marker interpretation stays with the caller's authority. */
export async function discoverTentSystemRoot(
  cwd: string,
  probe: TentRootProbe,
  stopAt?: string,
): Promise<string | undefined> {
  let dir = path.resolve(cwd);
  const boundary = stopAt ? path.resolve(stopAt) : undefined;
  for (;;) {
    const direct = await probe(dir);
    if (direct) return dir;
    const nested = path.join(dir, ".tent");
    const child = await probe(nested);
    if (child) return nested;
    if (await fs.lstat(path.join(dir, ".git")).catch(() => undefined)) {
      const checkout = await readGitCheckout(dir);
      const main = checkout ? await linkedMainCheckout(checkout) : undefined;
      const shared = main ? path.join(main, ".tent") : undefined;
      return shared && (await probe(shared)) === true ? shared : undefined;
    }
    if (boundary && dir === boundary) return;
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
