import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  sectionFingerprints,
  sectionKey,
  type SectionPrint,
  type SectionTarget,
} from "../core/return/section-fingerprint.js";
import type { StopMaterialFile } from "../core/return/stop-material-index.js";
import { FileLockGuardBusyError, withFileLockGuard } from "./file-lock-guard.js";

type Section = Required<StopMaterialFile>;
/** One record entry: a linked section's fingerprint, with the heading line that selected it. */
export type SectionEntry = { heading: string } & SectionPrint;
type Changed = Map<string, Section & SectionPrint>;

/**
 * One record per linked file. SessionStart replaces it whole; hooks only append, and the
 * last entry for a heading wins.
 */
const recordPath = (systemRoot: string, workspacePath: string) =>
  path.join(
    systemRoot,
    "temp",
    "section-fingerprints",
    createHash("sha256")
      .update(process.platform === "win32" ? workspacePath.toLowerCase() : workspacePath)
      .digest("hex"),
  );

/**
 * Reading a linked file and writing its record happen under one short lock, so the record
 * lists versions in the order they were read. The guard is reclaimed only once its holder
 * has exited. A hook that cannot take it in half a second gets undefined and writes
 * nothing, which can only repeat a reminder later.
 */
export async function withRecordLock<T>(
  systemRoot: string,
  workspacePath: string,
  action: () => Promise<T>,
): Promise<{ value: T } | undefined> {
  const record = recordPath(systemRoot, workspacePath);
  await fs.mkdir(path.dirname(record), { recursive: true });
  try {
    return { value: await withFileLockGuard(record, action, { waitMs: 500, flush: false }) };
  } catch (error) {
    if (error instanceof FileLockGuardBusyError) return undefined;
    throw error;
  }
}

export async function readText(filename: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filename, "utf8");
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
}

async function readRecord(
  systemRoot: string,
  workspacePath: string,
): Promise<Map<string, SectionPrint>> {
  const record = new Map<string, SectionPrint>();
  const text = await readText(recordPath(systemRoot, workspacePath)).catch(() => undefined);
  for (const row of text?.split("\n") ?? []) {
    let entry: unknown;
    try {
      entry = JSON.parse(row);
    } catch {
      continue;
    }
    const { heading, fingerprint, line } = (entry ?? {}) as Partial<SectionEntry>;
    if (typeof heading !== "string" || typeof fingerprint !== "string") continue;
    const kept = typeof line === "string" ? line : record.get(heading)?.line;
    record.set(heading, { fingerprint, ...(kept === undefined ? {} : { line: kept }) });
  }
  return record;
}

const entry = ({ heading, fingerprint, line }: SectionEntry): SectionEntry => ({
  heading,
  fingerprint,
  ...(line === undefined ? {} : { line }),
});
const rows = (entries: readonly SectionEntry[]) =>
  entries.map((value) => JSON.stringify(entry(value)) + "\n").join("");

async function withDirectory(target: string, write: () => Promise<void>): Promise<void> {
  await write().catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await write();
  });
}

/** Replace a record whole, so a concurrent reader sees the old or the new one. */
export async function replaceRecord(
  systemRoot: string,
  workspacePath: string,
  entries: readonly SectionEntry[],
): Promise<void> {
  const target = recordPath(systemRoot, workspacePath);
  const temp = `${target}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await withDirectory(target, () => fs.writeFile(temp, rows(entries)));
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function appendRecord(
  systemRoot: string,
  workspacePath: string,
  entries: readonly SectionEntry[],
): Promise<void> {
  const target = recordPath(systemRoot, workspacePath);
  await withDirectory(target, () => fs.appendFile(target, rows(entries)));
}

export function byFile<T extends Section>(sections: Iterable<T>): Map<string, T[]> {
  const files = new Map<string, T[]>();
  for (const section of sections) {
    const key = process.platform === "win32" ? section.path.toLowerCase() : section.path;
    files.set(key, [...(files.get(key) ?? []), section]);
  }
  return files;
}

/**
 * Sections whose fingerprint differs from the record, as read now.
 * A section without a record is unknown, so it is recorded and stays quiet.
 */
export async function changedSections(
  systemRoot: string,
  workspaceRoot: string,
  sections: ReadonlyMap<string, Section>,
): Promise<Changed> {
  const changed: Changed = new Map();
  await Promise.all(
    [...byFile(sections.values()).values()].map(async (file) => {
      const workspacePath = file[0]!.path;
      const observe = async (locked: boolean) => {
        const record = await readRecord(systemRoot, workspacePath);
        const prints = sectionFingerprints(
          await readText(path.join(workspaceRoot, workspacePath)),
          file.map(({ heading }) => {
            const line = record.get(heading)?.line;
            return line === undefined ? { heading } : { heading, line };
          }),
        );
        const unknown: SectionEntry[] = [];
        for (const section of file) {
          const print = prints.get(section.heading)!;
          const recorded = record.get(section.heading);
          if (!recorded) unknown.push({ heading: section.heading, ...print });
          else if (recorded.fingerprint !== print.fingerprint)
            changed.set(sectionKey(section.path, section.heading), { ...section, ...print });
        }
        if (locked && unknown.length) await appendRecord(systemRoot, workspacePath, unknown);
      };
      if (!(await withRecordLock(systemRoot, workspacePath, () => observe(true))))
        await observe(false);
    }),
  );
  return changed;
}

/**
 * The caller settles a changed section only after every Node that links it was named, and
 * only while the file still holds the version that write saw.
 */
export async function settleSections(
  systemRoot: string,
  workspaceRoot: string,
  changed: Changed,
): Promise<void> {
  await Promise.all(
    [...byFile(changed.values()).values()].map((file) =>
      withRecordLock(systemRoot, file[0]!.path, async () => {
        const now = sectionFingerprints(
          await readText(path.join(workspaceRoot, file[0]!.path)),
          file,
        );
        const settled = file.filter(
          (section) => now.get(section.heading)!.fingerprint === section.fingerprint,
        );
        if (settled.length) await appendRecord(systemRoot, file[0]!.path, settled);
      }),
    ),
  );
}
