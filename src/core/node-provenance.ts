import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import * as z from "zod/v4";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";

export const nodeActorSchema = z
  .string()
  .trim()
  .regex(
    /^(?:(?:human|process):[^\r\n]*\S[^\r\n]*|[^\s/:]+\/[^\s]+)$/,
    "Actor must use human:<id>, process:<id>, or <producer>/<version>",
  );
export const okfTimestampSchema = z.iso.datetime({ offset: true });
const generatedSchema = z.looseObject({ by: nodeActorSchema, at: okfTimestampSchema.optional() });
const verificationSchema = z.looseObject({ by: nodeActorSchema, at: okfTimestampSchema });
const verifiedSchema = z.union([verificationSchema, z.array(verificationSchema)]);
export type NodeVerification = z.infer<typeof verificationSchema>;
export type NodeTrustTier = "unverified" | "machine-confirmed" | "human-reviewed";

declare const __TENT_BUILD_IDENTITY_JSON__: string | undefined;
let fallbackActor: string | undefined;

/** Build identity is authoritative; source execution uses this package's own version. */
export function defaultNodeActor(): string {
  if (fallbackActor) return fallbackActor;
  const pkg =
    typeof __TENT_BUILD_IDENTITY_JSON__ === "undefined"
      ? JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
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

export function nodeTrustTier(data: Record<string, unknown>): NodeTrustTier {
  const verified = nodeVerifications(data);
  return verified.some((entry) => entry.by.startsWith("human:"))
    ? "human-reviewed"
    : verified.length
      ? "machine-confirmed"
      : "unverified";
}

export function nodeIsStale(
  data: Record<string, unknown>,
  now = new Date().toISOString(),
): boolean {
  if (data.stale_after === undefined) return false;
  return (
    Date.parse(okfTimestampSchema.parse(now)) >=
    Date.parse(okfTimestampSchema.parse(data.stale_after))
  );
}

/** Validate new native declarations while retaining unrelated metadata and unchanged disk values. */
export function assertNodeProvenanceEdit(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): void {
  for (const [field, schema] of [
    ["generated", generatedSchema],
    ["verified", verifiedSchema],
    ["stale_after", okfTimestampSchema],
  ] as const) {
    if (next[field] !== undefined && !isDeepStrictEqual(previous[field], next[field]))
      schema.parse(next[field]);
  }
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

function meaningfulContent(data: Record<string, unknown>, body: string) {
  const semantic = { ...data };
  for (const field of ["id", "title", "generated", "verified", "status", "stale_after"])
    delete semantic[field];
  return { semantic, body };
}

/** Generation records content production, never observation, verification, or lifecycle edits. */
export function prepareNodeProvenanceSave(
  raw: string,
  previousRaw: string | null,
  by?: string,
  now = new Date().toISOString(),
): string {
  const actor = nodeActorSchema.parse(by ?? defaultNodeActor());
  const parsed = parseFrontmatter(raw);
  const previous = previousRaw === null ? undefined : parseFrontmatter(previousRaw);
  assertNodeProvenanceEdit(previous?.data ?? {}, parsed.data);
  if (
    previous &&
    isDeepStrictEqual(
      meaningfulContent(previous.data, previous.body),
      meaningfulContent(parsed.data, parsed.body),
    )
  )
    return raw;
  const previousGenerated = parsed.data.generated;
  parsed.data.generated = {
    ...(typeof previousGenerated === "object" &&
    previousGenerated !== null &&
    !Array.isArray(previousGenerated)
      ? previousGenerated
      : {}),
    by: actor,
    at: okfTimestampSchema.parse(now),
  };
  return serializeFrontmatter(parsed.data, parsed.body, parsed.keyOrder);
}
