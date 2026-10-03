import type { Clock, FsAdapter } from "./adapter.js";
import type { RandomSource } from "./id.js";

export interface OpsEnv {
  fs: FsAdapter;
  clock: Clock;
  tentName: string;
  /** Absolute Tent root used in relay prompts by CLI clients. */
  tentRoot?: string;
  rand?: RandomSource;
}
