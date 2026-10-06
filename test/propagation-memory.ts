import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { FsAdapter } from "../src/core/adapter.js";
import {
  GitDocumentHistory,
  type CaptureMetadata,
  type DocumentChange,
  type DocumentVersion,
  type HistoryCommit,
} from "../src/core/git-history.js";
import type { NodeBasisRecord } from "../src/core/node-basis-record.js";
import { parseFrontmatter } from "../src/core/frontmatter.js";
import { materialLocator } from "../src/core/material.js";

/** Storage-only fixture: baselines are produced exclusively by the real Core. */
export class PropagationMemoryFs implements FsAdapter {
  readonly files = new Map<string, string>();
  readonly directories = new Set(["", ".git"]);
  readonly history: GitDocumentHistory;

  constructor() {
    const snapshots = new Map<string, Map<string, string>>();
    const events: HistoryCommit[] = [];
    const records: Record<string, NodeBasisRecord> = {};
    const recordEvents: Record<string, Record<string, NodeBasisRecord>> = {};
    const images = new Map<
      string,
      Array<{ path: string; before: string | null; after: string | null }>
    >();
    const head = () => events.at(-1)?.commit ?? null;
    const tree = () => snapshots.get(head() ?? "") ?? new Map<string, string>();
    const history = new GitDocumentHistory("memory-only");
    history.available = async () => true;
    history.currentCommit = async () => head();
    history.nodeRecords = async () => structuredClone(records);
    history.nodeRecordEvents = async () => structuredClone(recordEvents);
    history.captureUnlocked = async (
      changes: readonly DocumentChange[],
      metadata?: CaptureMetadata,
    ) => {
      const previous = tree();
      const changed = changes.filter(({ path, raw }) => (previous.get(path) ?? null) !== raw);
      const recordChanged = Object.entries(metadata?.nodeRecords ?? {}).some(
        ([id, record]) => !isDeepStrictEqual(records[id], record),
      );
      if (changed.length || recordChanged) {
        const commit = createHash("sha1")
          .update(String(events.length + 1))
          .digest("hex");
        const snapshot = new Map(previous);
        images.set(
          commit,
          changed.map(({ path, raw }) => ({
            path,
            before: previous.get(path) ?? null,
            after: raw,
          })),
        );
        for (const { path, raw } of changed) {
          if (raw === null) snapshot.delete(path);
          else snapshot.set(path, raw);
        }
        const event: HistoryCommit = {
          commit,
          time: new Date(Date.UTC(2026, 9, 6, 0, 0, events.length)).toISOString(),
          ...(head() ? { parent: head()! } : {}),
          operation: metadata?.operation,
          objectIds: [],
          changes: changed.map(({ path, raw }) => {
            const before = previous.get(path);
            const id = parseFrontmatter(raw ?? before ?? "").data.id;
            return {
              ...(typeof id === "string" ? { objectId: id } : {}),
              ...(before !== undefined && head() ? { before: { commit: head()!, path } } : {}),
              ...(raw !== null ? { after: { commit, path } } : {}),
            };
          }),
        };
        event.objectIds = [
          ...new Set(event.changes.flatMap((x) => (x.objectId ? [x.objectId] : []))),
        ];
        events.push(event);
        snapshots.set(commit, snapshot);
        if (metadata?.nodeRecords) {
          recordEvents[commit] = structuredClone(metadata.nodeRecords);
          Object.assign(records, structuredClone(metadata.nodeRecords));
        }
      }
      return {
        commit: head(),
        created: !!(changed.length || recordChanged),
        versions: changes
          .filter((x) => x.raw !== null)
          .map(({ path }) => ({ commit: head()!, path })),
      };
    };
    history.read = async ({ commit, path }) => {
      const raw = snapshots.get(commit)?.get(path);
      if (raw === undefined) throw new Error(`Missing history: ${commit}:${path}`);
      return raw;
    };
    history.changedSince = async ({ commit, path }) => {
      const index = events.findIndex((x) => x.commit === commit);
      if (index < 0) throw new Error(`Unknown commit ${commit}`);
      return events
        .slice(index + 1)
        .some((x) => images.get(x.commit)!.some((c) => c.path === path));
    };
    history.readVersions = async (versions) =>
      Promise.all(
        versions.map(async (version) => {
          try {
            const raw = await history.read(version);
            return {
              version,
              raw,
              frontmatter: parseFrontmatter(raw).data,
              changedSince: await history.changedSince(version),
            };
          } catch (error) {
            return error instanceof Error ? error : new Error(String(error));
          }
        }),
      );
    history.pathVersions = async (file) => {
      const versions = events.flatMap((x) =>
        x.changes.flatMap((c) => (c.after?.path === file ? [c.after] : [])),
      );
      return { first: versions[0], latest: versions.at(-1) };
    };
    history.readDirectory = async (commit, directory) =>
      new Map([...(snapshots.get(commit) ?? [])].filter(([p]) => p.startsWith(directory + "/")));
    history.changesInRange = async ({ from, to } = {}) =>
      structuredClone(
        events.slice(
          from ? events.findIndex((x) => x.commit === from) + 1 : 0,
          to ? events.findIndex((x) => x.commit === to) + 1 : undefined,
        ),
      );
    history.derived = async (_name, _version, compute) => compute(head());
    history.commitTime = async (commit) => events.find((x) => x.commit === commit)!.time;
    const times = async (files: readonly string[], latest: boolean) =>
      new Map(
        files.flatMap((file) => {
          const selected = events.filter((x) => images.get(x.commit)!.some((c) => c.path === file));
          const event = latest ? selected.at(-1) : selected[0];
          return event ? [[file, event.time] as const] : [];
        }),
      );
    history.firstCommitTimes = (files) => times(files, false);
    history.latestCommitTimes = (files) => times(files, true);
    history.commitChanges = async (commit) => ({
      commit,
      parent: events.find((x) => x.commit === commit)!.parent!,
      changes: images.get(commit)!,
    });
    this.history = history;
  }

  async listDir(dir: string) {
    const prefix = dir ? dir + "/" : "";
    const entries = new Map<string, boolean>();
    for (const p of this.directories)
      if (p.startsWith(prefix) && p !== dir && !p.slice(prefix.length).includes("/"))
        entries.set(p.slice(prefix.length), true);
    for (const p of this.files.keys())
      if (p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
        entries.set(p.slice(prefix.length), false);
    return [...entries].map(([name, isDir]) => ({ name, isDir }));
  }
  async readFile(p: string) {
    const raw = this.files.get(p);
    if (raw === undefined) throw Object.assign(new Error(`Missing ${p}`), { code: "ENOENT" });
    return raw;
  }
  async readFrontmatter(p: string) {
    const raw = await this.readFile(p);
    const parsed = parseFrontmatter(raw);
    return raw.slice(0, raw.length - parsed.body.length);
  }
  async writeFile(p: string, raw: string) {
    await this.mkdir(path.posix.dirname(p));
    this.files.set(p, raw);
  }
  async readBinary(p: string) {
    return Buffer.from(await this.readFile(p));
  }
  async writeBinary(p: string, raw: Uint8Array) {
    await this.writeFile(p, Buffer.from(raw).toString());
  }
  async exists(p: string) {
    return this.files.has(p) || this.directories.has(p);
  }
  async mkdir(p: string) {
    if (p === ".") return;
    const parts = p.split("/");
    for (let i = 1; i <= parts.length; i++) this.directories.add(parts.slice(0, i).join("/"));
  }
  async move(from: string, to: string) {
    for (const [p, raw] of [...this.files])
      if (p === from || p.startsWith(from + "/")) {
        this.files.delete(p);
        this.files.set(to + p.slice(from.length), raw);
      }
    for (const p of [...this.directories])
      if (p === from || p.startsWith(from + "/")) {
        this.directories.delete(p);
        this.directories.add(to + p.slice(from.length));
      }
  }
  async remove(p: string) {
    for (const q of [...this.files.keys()])
      if (q === p || q.startsWith(p + "/")) this.files.delete(q);
    for (const q of [...this.directories])
      if (q === p || q.startsWith(p + "/")) this.directories.delete(q);
  }
  async removeEmptyDir(p: string) {
    if ((await this.listDir(p)).length) throw new Error("Not empty");
    this.directories.delete(p);
  }
  async withLock<T>(_p: string, action: () => Promise<T>) {
    return action();
  }
  async observeMaterial(resource: string, documentPath: string) {
    const locator = materialLocator(resource, documentPath);
    if (locator.kind !== "path") throw new Error("Fixture only observes local materials");
    const raw = await this.readFile(locator.target);
    return {
      observedVersion: createHash("sha256").update(raw.replace(/\r\n?/g, "\n")).digest("hex"),
    };
  }
}
