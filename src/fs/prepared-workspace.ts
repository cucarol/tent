import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type { AgentContextRepository } from "../core/read/agent-context.js";
import type { PreparedRepositoryObservation } from "./prepared-repository.js";

export type PreparedWorkspace = {
  repository: AgentContextRepository;
  live: string[];
  tracked: string[];
};

const snapshots = new AsyncLocalStorage<PreparedRepositoryObservation<PreparedWorkspace> | null>();

export function withPreparedWorkspace<T>(
  snapshot: PreparedRepositoryObservation<PreparedWorkspace> | null,
  action: () => Promise<T>,
): Promise<T> {
  return snapshots.run(snapshot, action);
}

export function currentPreparedWorkspace(root: string) {
  const snapshot = snapshots.getStore();
  return snapshot?.workspaceRoot === path.resolve(root) ? snapshot.value : undefined;
}

export function isPreparedWorkspace(value: unknown): value is PreparedWorkspace {
  if (!value || typeof value !== "object") return false;
  const item = value as PreparedWorkspace;
  const strings = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((s) => typeof s === "string");
  return (
    !!item.repository &&
    strings(item.repository.trackedFiles) &&
    !!item.repository.sources &&
    Array.isArray(item.repository.sources.files) &&
    item.repository.sources.files.every(
      (f) =>
        typeof f.path === "string" && (f.content === undefined || typeof f.content === "string"),
    ) &&
    Array.isArray(item.repository.sources.errors) &&
    item.repository.sources.errors.length === 0 &&
    strings(item.live) &&
    strings(item.tracked)
  );
}
