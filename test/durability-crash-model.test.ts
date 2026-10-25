import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { NodeFs } from "../src/fs/node-fs.js";
import { GitDocumentHistory } from "../src/core/store/git-history.js";
import { testScratchRoot } from "./scratch.js";

test(
  "interruption checkpoints zero only unsynced files and retain readable old/new documents and history",
  { timeout: 180_000 },
  async (t) => {
    const scratch = await fs.mkdtemp(path.join(testScratchRoot(), "durability-model-"));
    t.after(() => fs.rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
    const baseline = path.join(scratch, "baseline", ".tent");
    await fs.mkdir(baseline, { recursive: true });
    execFileSync("git", ["-C", baseline, "init", "--quiet"], { windowsHide: true });
    const old = "---\nid: node-n\ntype: prompt\n---\nold complete bytes\n";
    const next = old.replace("old complete bytes", "new complete bytes");
    const adapter = new NodeFs(baseline);
    await adapter.writeFile("N/N.md", old);
    const initial = (await adapter.history.captureUnlocked([{ path: "N/N.md", raw: old }])).commit!;
    const branch = execFileSync("git", ["-C", baseline, "symbolic-ref", "HEAD"], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    const legacy = `${"0".repeat(initial.length)} ${initial} Tent <tent@local.invalid> 1792870000 +0800\n`;
    for (const file of ["logs/HEAD", `logs/${branch}`]) {
      await fs.mkdir(path.dirname(path.join(baseline, ".git", file)), { recursive: true });
      await fs.writeFile(path.join(baseline, ".git", file), legacy, { flush: true });
    }
    const child = fileURLToPath(new URL("./helpers/durability-crash-child.ts", import.meta.url));
    const points = [
      "file-written",
      "file-synced",
      "before-rename",
      "after-rename",
      "after-hash-object",
      "after-write-tree",
      "after-commit-tree",
      "after-update-ref",
      "after-reflog-migration",
      "after-index-mirror",
      "after-return",
    ];
    for (const point of points) {
      const root = path.join(scratch, point, ".tent");
      await fs.cp(baseline, root, { recursive: true });
      const stopped = spawnSync(process.execPath, ["--import", "tsx", child, root, point], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 25_000,
      });
      assert.equal(stopped.status, 77, `${point}: ${stopped.stderr}\n${stopped.stdout}`);
      const observation = JSON.parse(stopped.stdout.trim());
      assert.equal(observation.point, point);
      await assert.rejects(fs.stat(path.join(root, ".git/logs")), { code: "ENOENT" });
      const archives = await fs.readdir(path.join(root, ".git/tent-reflogs"));
      assert.equal(archives.length, 1);
      for (const log of ["HEAD", branch])
        assert.equal(
          await fs.readFile(path.join(root, ".git/tent-reflogs", archives[0]!, log), "utf8"),
          legacy,
          `${point}: archived logs must remain exact old bytes`,
        );
      await new NodeFs(root).ready();
      const bytes = await fs.readFile(path.join(root, "N/N.md"), "utf8");
      assert.ok(bytes === old || bytes === next, `${point}: published document must be complete`);
      const reader = new GitDocumentHistory(root),
        head = await reader.currentCommit();
      assert.ok(head);
      assert.equal(await reader.available(), true, point);
      const retained = (await reader.readDirectory(head)).get("N/N.md");
      assert.ok(
        retained === old || retained === next,
        `${point}: retained document must be complete`,
      );
      assert.equal(
        bytes,
        retained,
        `${point}: normal opening settles disk and HEAD to one version`,
      );
      assert.equal(await reader.read({ commit: initial, path: "N/N.md" }), old, point);
      execFileSync("git", ["-C", root, "fsck", "--full", "--no-dangling"], { windowsHide: true });
      if (point === "after-return") {
        assert.equal(bytes, next);
        assert.equal(retained, next);
        assert.ok(
          !observation.zeroed.some((file: string) =>
            /(?:N\.md|logs[/\\]|refs[/\\]|[/\\]index$)/.test(file),
          ),
          "completed save has no unsynced authoritative file",
        );
      }
      t.diagnostic(
        `${point}: disk=${bytes === old ? "old" : "new"}, retained=${retained === old ? "old" : "new"}, unsynced=${observation.zeroed.length}`,
      );
    }
    const invalid = path.join(scratch, "bad-order", ".tent");
    await fs.cp(baseline, invalid, { recursive: true });
    const stopped = spawnSync(
      process.execPath,
      ["--import", "tsx", child, invalid, "after-rename", "bad-order"],
      { encoding: "utf8", windowsHide: true, timeout: 25_000 },
    );
    assert.equal(stopped.status, 77, stopped.stderr);
    const invalidBytes = await fs.readFile(path.join(invalid, "N/N.md"));
    assert.ok(
      invalidBytes.length && invalidBytes.every((byte) => byte === 0),
      "negative control publishes unsynced bytes and the injected crash destroys them",
    );
    assert.ok(
      invalidBytes.toString("utf8") !== old && invalidBytes.toString("utf8") !== next,
      "old/new byte oracle rejects the bad publication order",
    );
    t.diagnostic(
      "negative control: publication without sync was detected as zero-filled, not old/new",
    );
  },
);
