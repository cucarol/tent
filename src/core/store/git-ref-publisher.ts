import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** One invocation's Git transaction transport. Git still owns reference locking and CAS. */
export class GitRefPublisher {
  private output = "";
  private stderr = "";
  private failure?: Error;
  private closed = false;
  private transaction = false;
  private pending?: { resolve(line: string): void; reject(error: Error): void };
  private readonly exited: Promise<void>;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.exited = new Promise((resolve) => {
      child.once("error", (error) => this.fail(error));
      child.once("close", (code, signal) => {
        this.closed = true;
        this.fail(
          new Error(`Git reference session ended (${code ?? signal}): ${this.stderr.trim()}`),
        );
        resolve();
      });
    });
    child.stdin.on("error", (error) => this.fail(error));
    child.stderr.on("data", (bytes: Buffer) => (this.stderr += bytes.toString("utf8")));
    child.stdout.on("data", (bytes: Buffer) => {
      this.output += bytes.toString("utf8");
      for (let end; (end = this.output.indexOf("\n")) >= 0;) {
        const line = this.output.slice(0, end).trim();
        this.output = this.output.slice(end + 1);
        const pending = this.pending;
        this.pending = undefined;
        if (pending) pending.resolve(line);
        else this.fail(new Error(`Unexpected Git reference response: ${line}`));
      }
    });
  }

  static async open(child: ChildProcessWithoutNullStreams): Promise<GitRefPublisher> {
    const publisher = new GitRefPublisher(child);
    try {
      await publisher.command("start", "start: ok");
      publisher.transaction = true;
      return publisher;
    } catch (error) {
      await publisher.close();
      throw error;
    }
  }

  private fail(error: Error) {
    this.failure ??= error;
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(this.failure);
  }

  get usable(): boolean {
    return !this.closed && !this.failure;
  }

  private command(command: string, expected: string): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending) return Promise.reject(new Error("Concurrent Git reference transaction"));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.fail(new Error(`Git reference session timed out waiting for ${expected}`));
        this.child.kill();
      }, 10_000);
      timeout.unref();
      this.pending = {
        resolve: (line) => {
          clearTimeout(timeout);
          if (line === expected) resolve();
          else {
            const error = new Error(`Unexpected Git reference response: ${line}`);
            this.fail(error);
            reject(error);
          }
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      };
      this.child.stdin.write(`${command}\n`);
    });
  }

  async publish(commit: string, previous: string | null): Promise<void> {
    if (!this.transaction) {
      await this.command("start", "start: ok");
      this.transaction = true;
    }
    await this.command(
      `update HEAD ${commit} ${previous ?? "0".repeat(commit.length)}\nprepare`,
      "prepare: ok",
    );
    await this.command("commit", "commit: ok");
    this.transaction = false;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    // EOF aborts an uncommitted transaction. A final exit error must not turn
    // an acknowledged publication into a failed save after HEAD became live.
    this.child.stdin.end();
    const timeout = setTimeout(() => this.child.kill("SIGKILL"), 2_000);
    timeout.unref();
    try {
      await this.exited;
    } finally {
      clearTimeout(timeout);
    }
  }
}
