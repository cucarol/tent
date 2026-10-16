import type { ModuleDependencies } from "../graph/module-dependencies.js";

export type ModuleDependencyMode = "watch" | "verify";
export type ModuleDependencyResponse = ModuleDependencies & {
  computedAt: string;
  fresh: boolean;
  mode: ModuleDependencyMode;
  /** Why this service must verify inputs on every request instead of reusing a watched result. */
  reason?: string;
};

type Subscription = { close(): void };
type Options = {
  compute(): Promise<ModuleDependencies>;
  watch(changed: () => void, unavailable: (error: unknown) => void): Promise<Subscription>;
  reportMode(mode: ModuleDependencyMode, reason?: string): void;
  now?: () => number;
};

/** UI-only derived result. CLI queries still read current inputs on every call. */
export function createModuleDependencyQuery(options: Options) {
  const now = options.now ?? Date.now;
  let mode: ModuleDependencyMode = "watch";
  let reason: string | undefined;
  let generation = 0;
  let dirtySince: number | undefined;
  let closed = false;
  let subscription: Subscription | undefined;
  let starting: Promise<void> | undefined;
  let pending: Promise<ModuleDependencyResponse> | undefined;
  let cached: (ModuleDependencies & { computedAt: string }) | undefined;

  const response = (fresh: boolean): ModuleDependencyResponse => ({
    ...cached!,
    computedAt: cached!.computedAt,
    fresh,
    mode,
    ...(reason ? { reason } : {}),
  });

  function unavailable(error: unknown) {
    if (closed || mode === "verify") return;
    mode = "verify";
    reason = error instanceof Error ? error.message : String(error);
    generation++;
    dirtySince ??= now();
    subscription?.close();
    subscription = undefined;
    options.reportMode(mode, reason);
  }

  function changed() {
    if (closed || mode !== "watch") return;
    generation++;
    dirtySince ??= now();
    // Start immediately, even when the UI isn't polling. A later read sees the new result.
    if (cached) void build().catch(() => undefined);
  }

  function ready() {
    return (starting ??= options.watch(changed, unavailable).then((watch) => {
      if (closed || mode === "verify") watch.close();
      else {
        subscription = watch;
        options.reportMode(mode);
      }
    }, unavailable));
  }

  function build(): Promise<ModuleDependencyResponse> {
    if (pending) return pending;
    const run = async () => {
      while (!closed) {
        const observed = generation;
        const result = await options.compute();
        if (closed) break;
        // An event during a read cannot bless a mixed observation as the current graph.
        if (generation !== observed) continue;
        cached = { ...result, computedAt: new Date(now()).toISOString() };
        dirtySince = undefined;
        return response(true);
      }
      throw new Error("Module dependency query is closed");
    };
    pending = run().finally(() => {
      pending = undefined;
    });
    return pending;
  }

  return {
    async read(): Promise<ModuleDependencyResponse> {
      if (closed) throw new Error("Module dependency query is closed");
      await ready();
      if (closed) throw new Error("Module dependency query is closed");
      if (mode === "verify" || !cached) return build();
      if (dirtySince === undefined) return response(true);
      const refreshing = build();
      // Once the allowed transition window ends, wait for current data or report its error.
      if (now() - dirtySince >= 2000) return refreshing;
      void refreshing.catch(() => undefined);
      return response(false);
    },
    async close() {
      closed = true;
      subscription?.close();
      subscription = undefined;
      await starting;
      await pending?.catch(() => undefined);
      cached = undefined;
    },
  };
}
