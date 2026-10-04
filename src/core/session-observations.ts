import { createHash } from "node:crypto";
import * as z from "zod/v4";
import type { FsAdapter } from "./adapter.js";
import { MUTATION_LOCK_PATH } from "./paths.js";
import { isNodeId, isCardId } from "./id.js";

const identity = z.string().min(1).max(1024);
const timestamp = z.iso.datetime({ offset: true });
const address = z
  .string()
  .min(1)
  .refine((value) => {
    if (/[\u0000-\u001f]/.test(value)) return false;
    if (value.startsWith("file:")) {
      try {
        const url = new URL(value);
        return (
          url.protocol === "file:" &&
          (!url.hostname || url.hostname === "localhost") &&
          !url.pathname.startsWith("//") &&
          !url.search &&
          !url.hash
        );
      } catch {
        return false;
      }
    }
    return (
      !value.includes("\\") &&
      !value.startsWith("/") &&
      !/^[a-z][a-z\d+.-]*:/i.test(value) &&
      !value.split("/").some((part) => part === ".." || part === "." || !part)
    );
  });
export const sessionFileObservationSchema = z.strictObject({
  kind: z.enum(["provided", "read", "written"]),
  address,
  eventAt: timestamp.optional(),
});
export type SessionFileObservation = z.infer<typeof sessionFileObservationSchema>;
export const sessionSignalSchema = z.enum(["possible-requirement", "possible-decision"]);
export type SessionSignal = z.infer<typeof sessionSignalSchema>;
export type SessionObservationActivity = {
  observations: SessionFileObservation[];
  signals: SessionSignal[];
  uncertain: boolean;
  cancelled?: true;
  nodeOrCardChanged?: true;
};
const historyCommit = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
  .nullable();
const versionSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("observed"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    observedAt: timestamp,
    phase: z.literal("stop"),
  }),
  z.strictObject({
    state: z.literal("uncertain"),
    observedAt: timestamp,
    phase: z.literal("stop"),
  }),
]);
export const sessionObservationEventSchema = z.strictObject({
  schema: z.literal(1),
  type: z.literal("turn"),
  sessionId: identity,
  turnId: identity,
  observedAt: timestamp,
  files: z.array(sessionFileObservationSchema.extend({ version: versionSchema })),
  signals: z.array(sessionSignalSchema),
  uncertain: z.boolean(),
  cancelled: z.literal(true).optional(),
  nodeOrCardChanged: z.literal(true).optional(),
  historyCommit: historyCommit.optional(),
});
export type SessionObservationEvent = z.infer<typeof sessionObservationEventSchema>;
export type ObserveSessionFile = (address: string) => Promise<{ observedVersion: string }>;

/** Host identifiers are data, never filesystem path components. */
export function sessionObservationPath(sessionId: string): string {
  identity.parse(sessionId);
  return `temp/observations/${createHash("sha256").update(sessionId).digest("hex")}.jsonl`;
}

const baselineSchema = z.strictObject({ historyCommit });
const baselinePath = (sessionId: string) =>
  sessionObservationPath(sessionId).replace(/\.jsonl$/, ".baseline.json");

/** A host-session cursor only: no registration, ownership, prompt or document body. */
export async function saveSessionHistoryBaseline(fs: FsAdapter, sessionId: string): Promise<void> {
  if (!fs.history || !(await fs.exists(".git"))) return;
  const save = async () => {
    const filename = baselinePath(sessionId);
    if (await fs.exists(filename)) return;
    await fs.writeFile(
      filename,
      JSON.stringify({ historyCommit: await fs.history!.currentCommit() }) + "\n",
    );
  };
  if (fs.withLock) await fs.withLock(MUTATION_LOCK_PATH, save);
  else await save();
}

async function observeTentMutation(
  fs: FsAdapter,
  sessionId: string,
  events: SessionObservationEvent[],
) {
  if (!fs.history || !(await fs.exists(".git"))) return {};
  try {
    const commit = await fs.history.currentCommit();
    const previous = [...events].reverse().find((event) => event.historyCommit !== undefined);
    let from = previous?.historyCommit;
    if (from === undefined && (await fs.exists(baselinePath(sessionId))))
      from = baselineSchema.parse(
        JSON.parse(await fs.readFile(baselinePath(sessionId))),
      ).historyCommit;
    // Without a retained session boundary, old mutations are not evidence for this turn.
    const changed =
      from !== undefined &&
      commit !== null &&
      commit !== from &&
      (await fs.history.changesInRange({ ...(from ? { from } : {}), to: commit })).some(
        (record) =>
          /^(?:node|card)\./.test(record.operation ?? "") &&
          record.changes.some(
            (change) => change.objectId && (isNodeId(change.objectId) || isCardId(change.objectId)),
          ),
      );
    return { historyCommit: commit, ...(changed ? { nodeOrCardChanged: true as const } : {}) };
  } catch {
    // Missing/non-ancestor history cannot prove a semantic save.
    return {};
  }
}

function parseLog(raw: string, expectedSession?: string) {
  const events: SessionObservationEvent[] = [];
  let uncertain = raw.length > 0 && !raw.endsWith("\n");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = sessionObservationEventSchema.safeParse(JSON.parse(line));
      if (!parsed.success || (expectedSession && parsed.data.sessionId !== expectedSession)) {
        uncertain = true;
        continue;
      }
      events.push(parsed.data);
    } catch {
      uncertain = true;
    }
  }
  return { events, uncertain };
}

/** One atomic append per turn, including empty/aborted turns; no semantic graph writes. */
export async function appendSessionObservations(
  fs: FsAdapter,
  sessionId: string,
  turnId: string,
  activity: SessionObservationActivity,
  observe: ObserveSessionFile,
): Promise<{ event: SessionObservationEvent; appended: boolean }> {
  const filename = sessionObservationPath(sessionId);
  identity.parse(turnId);
  const save = async () => {
    const raw = (await fs.exists(filename)) ? await fs.readFile(filename) : "";
    const saved = parseLog(raw, sessionId);
    if (saved.uncertain) throw new Error("Session observation log requires repair");
    const existing = saved.events.find((event) => event.turnId === turnId);
    if (existing) return { event: existing, appended: false };
    const tentMutation = await observeTentMutation(fs, sessionId, saved.events);
    const files: SessionObservationEvent["files"] = [];
    const seen = new Set<string>();
    for (const input of activity.observations) {
      // Reconstruct only the allowed metadata; never serialize a caller's tool payload.
      const file = sessionFileObservationSchema.parse({
        kind: input.kind,
        address: input.address,
        ...(input.eventAt === undefined ? {} : { eventAt: input.eventAt }),
      });
      const key = JSON.stringify([file.kind, file.address, file.eventAt]);
      if (seen.has(key)) continue;
      seen.add(key);
      let version: z.infer<typeof versionSchema>;
      try {
        const current = await observe(file.address);
        version = versionSchema.parse({
          state: "observed",
          sha256: current.observedVersion,
          observedAt: new Date().toISOString(),
          phase: "stop",
        });
      } catch {
        version = { state: "uncertain", observedAt: new Date().toISOString(), phase: "stop" };
      }
      files.push({ ...file, version });
    }
    const event = sessionObservationEventSchema.parse({
      schema: 1,
      type: "turn",
      sessionId,
      turnId,
      observedAt: new Date().toISOString(),
      files,
      signals: [...new Set(activity.signals)],
      uncertain: activity.uncertain || files.some((file) => file.version.state === "uncertain"),
      ...(activity.cancelled ? { cancelled: true } : {}),
      ...tentMutation,
      ...(activity.nodeOrCardChanged ? { nodeOrCardChanged: true } : {}),
    });
    // NodeFs replaces through temp+rename, so failure cannot expose a partial JSONL line.
    // The shared lock protects read/dedupe/replace, including simultaneous Stop calls.
    await fs.writeFile(filename, raw + JSON.stringify(event) + "\n");
    return { event, appended: true };
  };
  return fs.withLock ? fs.withLock(MUTATION_LOCK_PATH, save) : save();
}

/** Invalid logs are uncertainty, never business content or error-message events. */
export async function readSessionObservations(
  fs: FsAdapter,
  options: { sessionId?: string } = {},
): Promise<{ events: SessionObservationEvent[]; uncertain: boolean }> {
  let filenames: string[];
  try {
    if (options.sessionId !== undefined) filenames = [sessionObservationPath(options.sessionId)];
    else {
      if (!(await fs.exists("temp/observations"))) return { events: [], uncertain: false };
      filenames = (await fs.listDir("temp/observations"))
        .filter((item) => !item.isDir && /^[a-f0-9]{64}\.jsonl$/.test(item.name))
        .map((item) => `temp/observations/${item.name}`);
    }
  } catch {
    return { events: [], uncertain: true };
  }
  let uncertain = false;
  const events: SessionObservationEvent[] = [];
  for (const filename of filenames) {
    try {
      if (!(await fs.exists(filename))) continue;
      const parsed = parseLog(await fs.readFile(filename), options.sessionId);
      uncertain ||= parsed.uncertain;
      for (const event of parsed.events) {
        if (sessionObservationPath(event.sessionId) !== filename) {
          uncertain = true;
          continue;
        }
        events.push(event);
      }
    } catch {
      uncertain = true;
    }
  }
  const seen = new Set<string>();
  return {
    events: events
      .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))
      .filter((event) => {
        const key = JSON.stringify([event.sessionId, event.turnId]);
        if (seen.has(key)) {
          uncertain = true;
          return false;
        }
        seen.add(key);
        return true;
      }),
    uncertain,
  };
}

export async function readRecentSessionObservations(
  fs: FsAdapter,
  options: { sessionId?: string; limit?: number } = {},
): Promise<{ events: SessionObservationEvent[]; uncertain: boolean }> {
  const limit = z
    .number()
    .int()
    .min(1)
    .max(100)
    .parse(options.limit ?? 20);
  const result = await readSessionObservations(fs, options);
  return { ...result, events: result.events.slice(0, limit) };
}
