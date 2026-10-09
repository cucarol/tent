import { syncBuiltinESMExports } from "node:module";
import timers from "node:timers/promises";
import type { TimerOptions } from "node:timers";
import { GitDocumentHistory } from "../../src/core/git-history.js";

// Observe the real CLI's completed Card scan and next idle delay without
// changing either the committed data or the polling promise/duration.
const readDirectory = GitDocumentHistory.prototype.readDirectory;
let scannedCommit: string | undefined;
let reportedCommit: string | undefined;
GitDocumentHistory.prototype.readDirectory = async function (commit, directory) {
  const result = await readDirectory.call(this, commit, directory);
  if (directory === "cards") scannedCommit = commit;
  return result;
};
const delay = timers.setTimeout;
timers.setTimeout = <T = void>(milliseconds?: number, value?: T, options?: TimerOptions) => {
  const pending = delay(milliseconds, value, options);
  if (scannedCommit !== undefined && scannedCommit !== reportedCommit) {
    reportedCommit = scannedCommit;
    process.send?.({ event: "watch-idle", commit: scannedCommit });
  }
  return pending;
};
syncBuiltinESMExports();
