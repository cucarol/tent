import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { TurnStart } from "../core/return/turn-changes.js";

export type TurnRecord = { turnId: string; checkout: string; baseline: TurnStart };
const key = (...parts: string[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const directory = (root: string) => path.join(root, "temp", "turn-reviews");
const filename = (root: string, host: string, session: string, turn: string) =>
  path.join(directory(root), key(host, session, turn) + ".json");
const continuationPath = (root: string, host: string, session: string) =>
  path.join(directory(root), key(host, session) + ".continuation.json");
const aliasPath = (root: string, host: string, session: string, turn: string) =>
  path.join(directory(root), key(host, session, turn) + ".alias.json");

/** Native tools need only a tiny continuation alias, never the full stat inventory. */
export async function turnReviewIdentity(
  root: string,
  host: string,
  session: string,
  turn: string,
): Promise<string> {
  try {
    const alias = JSON.parse(await fs.readFile(aliasPath(root, host, session, turn), "utf8"));
    return typeof alias.turnId === "string" && alias.turnId ? alias.turnId : turn;
  } catch {
    return turn;
  }
}

export async function readTurnRecord(
  root: string,
  host: string,
  session: string,
  turn: string,
): Promise<TurnRecord | undefined> {
  try {
    const identity = await turnReviewIdentity(root, host, session, turn);
    const record = JSON.parse(await fs.readFile(filename(root, host, session, identity), "utf8"));
    if (
      typeof record.turnId !== "string" ||
      typeof record.checkout !== "string" ||
      !Number.isFinite(record.baseline?.startedAt) ||
      !(record.baseline.head === null || /^[a-f0-9]{40,64}$/.test(record.baseline.head))
    )
      return;
    return record;
  } catch {
    return;
  }
}

export const turnDirtyPath = (root: string, host: string, session: string, checkout: string) =>
  path.join(directory(root), key(host, session, path.resolve(checkout)) + ".dirty.json");

export async function readTurnDirty(
  root: string,
  host: string,
  session: string,
  checkout: string,
): Promise<string[] | undefined> {
  try {
    const saved = JSON.parse(
      await fs.readFile(turnDirtyPath(root, host, session, checkout), "utf8"),
    );
    return saved.checkout === checkout &&
      Array.isArray(saved.paths) &&
      saved.paths.every((value: unknown) => typeof value === "string")
      ? saved.paths
      : undefined;
  } catch {
    return;
  }
}

/** Each completed observation publishes one whole record; readers never see partial JSON. */
export async function saveTurnDirty(
  root: string,
  host: string,
  session: string,
  checkout: string,
  paths: string[],
): Promise<void> {
  await fs.mkdir(directory(root), { recursive: true });
  const target = turnDirtyPath(root, host, session, checkout);
  const pending = target + "." + randomUUID() + ".pending";
  try {
    await fs.writeFile(pending, JSON.stringify({ checkout, paths }));
    await fs.rename(pending, target);
  } finally {
    await fs.rm(pending, { force: true }).catch(() => undefined);
  }
}

export async function saveTurnRecord(
  root: string,
  host: string,
  session: string,
  turn: string,
  record: TurnRecord,
): Promise<void> {
  await fs.mkdir(directory(root), { recursive: true });
  // Repeated submission of the same prompt never moves its original observation.
  const target =
    record.turnId === turn
      ? filename(root, host, session, turn)
      : aliasPath(root, host, session, turn);
  const data = record.turnId === turn ? record : { turnId: record.turnId };
  await fs.writeFile(target, JSON.stringify(data), { flag: "wx" }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
}

export async function rememberTurnContinuation(
  root: string,
  host: string,
  session: string,
  turnId: string,
  reason: string,
): Promise<void> {
  await fs.writeFile(continuationPath(root, host, session), JSON.stringify({ turnId, reason }));
}

/** Exact own reason only; neither transcripts nor prose heuristics identify continuations. */
export async function ownTurnContinuation(
  root: string,
  host: string,
  session: string,
  prompt: unknown,
): Promise<TurnRecord | undefined> {
  try {
    const saved = JSON.parse(await fs.readFile(continuationPath(root, host, session), "utf8"));
    if (typeof prompt !== "string" || prompt !== saved.reason || typeof saved.turnId !== "string")
      return;
    return readTurnRecord(root, host, session, saved.turnId);
  } catch {
    return;
  }
}
