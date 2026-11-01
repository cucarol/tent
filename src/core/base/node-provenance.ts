import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import * as z from "zod/v4";

export const nodeActorSchema = z
  .string()
  .trim()
  .regex(
    /^(?:(?:human|process):[^\r\n]*\S[^\r\n]*|[^\s/:]+\/[^\s]+)$/,
    "Actor must use human:<id>, process:<id>, or <producer>/<version>",
  );
export const okfTimestampSchema = z.iso.datetime({ offset: true });
const verificationSchema = z.looseObject({ by: nodeActorSchema, at: okfTimestampSchema });
const verifiedSchema = z.union([verificationSchema, z.array(verificationSchema)]);
export type NodeVerification = z.infer<typeof verificationSchema>;

declare const __TENT_BUILD_IDENTITY_JSON__: string | undefined;
let fallbackActor: string | undefined;

/** Build identity is authoritative; source execution uses this package's own version. */
export function defaultNodeActor(): string {
  if (fallbackActor) return fallbackActor;
  const pkg =
    typeof __TENT_BUILD_IDENTITY_JSON__ === "undefined"
      ? JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"))
      : JSON.parse(__TENT_BUILD_IDENTITY_JSON__);
  fallbackActor = nodeActorSchema.parse(`tent/${pkg.version}`);
  return fallbackActor;
}

/** OKF explicitly allows a single mapping as a one-element verification list. */
export function nodeVerifications(data: Record<string, unknown>): NodeVerification[] {
  if (data.verified === undefined) return [];
  const parsed = verifiedSchema.parse(data.verified);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Validate changed verification records while retaining unrelated metadata and unchanged disk values. */
export function assertNodeProvenanceEdit(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): void {
  if (next.verified !== undefined && !isDeepStrictEqual(previous.verified, next.verified))
    verifiedSchema.parse(next.verified);
}

export function recordNodeVerification(
  data: Record<string, unknown>,
  by?: string,
  now = new Date().toISOString(),
): void {
  const actor = nodeActorSchema.parse(by ?? defaultNodeActor());
  const at = okfTimestampSchema.parse(now);
  const latest = new Map<string, NodeVerification>();
  for (const entry of nodeVerifications(data)) {
    const previous = latest.get(entry.by);
    if (!previous || Date.parse(entry.at) >= Date.parse(previous.at)) latest.set(entry.by, entry);
  }
  const previous = latest.get(actor);
  if (!previous || Date.parse(at) >= Date.parse(previous.at))
    latest.set(actor, { ...previous, by: actor, at });
  data.verified = [...latest.values()];
}
