import { SqliteDocumentHistory } from "../../src/core/store/sqlite-history.js";
import { runRoleCommand } from "../../src/cli/role-commands.js";
import { DatabaseSync } from "../../src/fs/sqlite-runtime.js";

process.once("message", async () => {
  const started = performance.now(),
    history = new SqliteDocumentHistory(process.argv[2]!),
    prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql) {
    // Release the competing lock relative to the actual format read, not startup/FS timing.
    if (sql === "PRAGMA user_version") process.send!({ phase: "attempting" });
    return prepare.call(this, sql);
  };
  try {
    const input = JSON.parse(process.argv[3]!);
    const value =
      input.kind === "read"
        ? await history.currentCommit()
        : await runRoleCommand("write", input.args, { workspace: input.workspace });
    process.send!({ phase: "result", ok: true, value, elapsed: performance.now() - started });
  } catch (error) {
    process.send!({
      phase: "result",
      ok: false,
      message: String(error),
      stack: (error as Error).stack,
      elapsed: performance.now() - started,
    });
  } finally {
    DatabaseSync.prototype.prepare = prepare;
    await history.close();
    process.disconnect();
  }
});
process.send!({ phase: "ready" });
