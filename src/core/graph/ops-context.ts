import type { Clock, FsAdapter } from "../store/adapter.js";
import type { RandomSource } from "../base/id.js";

export interface OpsEnv {
  fs: FsAdapter;
  clock: Clock;
  tentName: string;
  /** Absolute Tent root used in relay prompts by CLI clients. */
  tentRoot?: string;
  rand?: RandomSource;
}
