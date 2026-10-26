import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import * as path from "node:path";
import { MUTATION_LOCK_PATH, TENT_SYSTEM_DIR, TEMP_DIR } from "../core/base/paths.js";

/** Filesystem events only wake a fresh Core read; they never establish workspace facts. */
export function changeHints(workspaceRoot: string) {
  // Windows watches the subtree through one root handle. Keeping handles to descendant
  // directories open prevents Core/CLI from renaming their parents on this platform.
  const nativeRecursive = process.platform === "win32";
  const clients = new Set<ServerResponse>();
  const subscribing = new Set<ServerResponse>();
  const lock = path.join(workspaceRoot, TENT_SYSTEM_DIR, MUTATION_LOCK_PATH);
  // Other platforms register only nonignored directories; Linux recursive watch would
  // otherwise walk and register caches, dependencies and worktrees before filtering events.
  const watchers = new Map<string, FSWatcher>();
  let starting: Promise<void> | undefined;
  let pending = new Set<string>();
  let scanning = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let closed = false;

  function stop() {
    generation++;
    clearTimeout(timer);
    timer = undefined;
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
    starting = undefined;
    pending = new Set();
    scanning = false;
  }

  function unavailable() {
    stop();
    for (const client of clients) client.destroy();
    clients.clear();
  }

  function removeDirectory(relative: string) {
    for (const [name, watcher] of watchers) {
      if (name !== relative && !name.startsWith(`${relative}/`)) continue;
      watcher.close();
      watchers.delete(name);
    }
  }

  async function addDirectory(relative: string, current: number): Promise<void> {
    if (current !== generation || watchers.has(relative)) return;
    let watcher: FSWatcher;
    try {
      watcher = watch(
        path.join(workspaceRoot, relative),
        { recursive: nativeRecursive },
        (_event, filename) => {
          if (current !== generation) return;
          const changed =
            filename === null
              ? relative
              : path.posix.join(relative, filename.toString().replace(/\\/g, "/"));
          if (ignored(changed)) return;
          if (nativeRecursive && _event === "change" && filename !== null) {
            // Windows also reports directory metadata changes caused by ordinary reads.
            // Subtree topology has rename events; only file changes need this wakeup.
            void stat(path.join(workspaceRoot, changed)).then(
              (state) => {
                if (current === generation && !state.isDirectory()) schedule();
              },
              (error: unknown) => {
                if (current !== generation) return;
                if (missing(error)) schedule();
                else unavailable();
              },
            );
            return;
          }
          schedule();
          if (nativeRecursive) return;
          // Renames include directory creation/deletion. Watch new subtrees before sending
          // another hint, covering writes made while their monitors were being installed.
          if (_event === "rename" || filename === null) {
            // A directory replaced at the same path has a new OS watch identity.
            if (filename !== null && watchers.has(changed)) removeDirectory(changed);
            rescan(relative, current);
          }
        },
      );
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    watchers.set(relative, watcher);
    watcher.on("error", () => {
      if (current === generation) unavailable();
    });
    watcher.unref();
    if (!nativeRecursive) await refreshDirectory(relative, current);
  }

  async function refreshDirectory(relative: string, current: number) {
    const entries = await readdir(path.join(workspaceRoot, relative), {
      withFileTypes: true,
    }).catch((error: unknown) => {
      if (!missing(error)) throw error;
      return undefined;
    });
    if (current !== generation) return;
    if (!entries) return removeDirectory(relative);
    const children = new Set(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.posix.join(relative, entry.name))
        .filter((name) => !ignored(name)),
    );
    for (const name of watchers.keys()) {
      if (name && path.posix.dirname(name) === (relative || ".") && !children.has(name))
        removeDirectory(name);
    }
    // Directory links are deliberately not followed outside the watched workspace.
    for (const child of children) await addDirectory(child, current);
  }

  function rescan(relative: string, current: number) {
    pending.add(relative);
    if (scanning) return;
    scanning = true;
    void (async () => {
      try {
        while (pending.size && current === generation) {
          const directory = pending.values().next().value!;
          pending.delete(directory);
          await refreshDirectory(directory, current);
        }
        if (current === generation) schedule();
      } catch {
        if (current === generation) unavailable();
      } finally {
        if (current === generation) scanning = false;
      }
    })();
  }

  function schedule() {
    if (!clients.size || timer) return;
    const current = generation;
    timer = setTimeout(() => void flush(current), 50);
    timer.unref();
  }

  async function flush(current: number) {
    // Keep the timer occupied during the stat so concurrent events stay in this batch.
    try {
      const held = await stat(lock).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
          throw error;
        },
      );
      if (current !== generation) return;
      timer = undefined;
      // CLI writes can span several filesystem events. Its lock release is another wakeup,
      // and this bounded wait also covers platforms that coalesce the release event.
      // A rename also refreshes nonrecursive monitors. Its asynchronous rescan
      // schedules this same burst when finished; publishing earlier emits it twice.
      if (held || scanning) return schedule();
      for (const client of clients) {
        // A slow reader reconnects and rereads; never queue unbounded hints for it.
        if (!client.write("event: change\ndata: {}\n\n")) client.destroy();
      }
    } catch {
      if (current === generation) unavailable();
    }
  }

  return {
    async subscribe(res: ServerResponse) {
      if (closed) throw new Error("The change stream is closing");
      subscribing.add(res);
      res.once("close", () => {
        subscribing.delete(res);
        clients.delete(res);
        if (!clients.size && !subscribing.size) stop();
      });
      const current = generation;
      try {
        await (starting ??= addDirectory("", current));
      } catch (error) {
        subscribing.delete(res);
        if (current === generation) unavailable();
        throw error;
      }
      subscribing.delete(res);
      if (current !== generation || closed) throw new Error("The change monitor is unavailable");
      if (res.destroyed) {
        if (!clients.size && !subscribing.size) stop();
        return false;
      }
      clients.add(res);
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.flushHeaders();
      // The client rereads after this subscription boundary, including reconnects.
      res.write(": connected\n\n");
      return true;
    },
    close() {
      closed = true;
      unavailable();
    },
  };
}

function missing(error: unknown) {
  return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
}

function ignored(filename: string) {
  const parts = filename.replace(/\\/g, "/").split("/");
  if (parts.some((part) => [".git", "node_modules", ".worktrees", ".scratch"].includes(part)))
    return true;
  if (parts[0] !== TENT_SYSTEM_DIR) return false;
  const entry = parts[1] ?? "";
  return (
    entry === TEMP_DIR ||
    entry.startsWith(`${MUTATION_LOCK_PATH}.guard`) ||
    entry.startsWith(`${MUTATION_LOCK_PATH}.stale-`)
  );
}
