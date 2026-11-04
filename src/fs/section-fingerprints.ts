import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  sectionFingerprints,
  sectionKey,
  type SectionPrint,
} from "../core/return/section-fingerprint.js";
type StopMaterialFile = { path: string; heading?: string };
import { readStructureSource } from "./source-observation.js";
import { FileLockBusyError, withFileLock } from "./file-lock.js";

type Section = Required<StopMaterialFile>;
/** One record entry: a linked section's fingerprint, with the heading line that selected it. */
export type SectionEntry = { heading: string } & SectionPrint;
type Changed = Map<string, Section & SectionPrint>;
export type StopSections = { changed: Changed; observed: Changed };

/**
 * One record per linked file within a checkout-specific Stop scope. Stop appends, and the
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
    return { value: await withFileLock(`${record}.lock`, action, { waitMs: 500, flush: false }) };
  } catch (error) {
    if (error instanceof FileLockBusyError) return undefined;
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

async function readSectionSource(root: string, filename: string): Promise<string | undefined> {
  try {
    return await readStructureSource(root, filename);
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
  baseline?: (file: string) => Promise<string | undefined>,
): Promise<StopSections> {
  const changed: Changed = new Map();
  const observed: Changed = new Map();
  await Promise.all(
    [...byFile(sections.values()).values()].map(async (file) => {
      const workspacePath = file[0]!.path;
      const recordKey = path.resolve(workspaceRoot, workspacePath);
      const observe = async (locked: boolean) => {
        const record = await readRecord(systemRoot, recordKey);
        const prints = sectionFingerprints(
          await readSectionSource(workspaceRoot, path.join(workspaceRoot, workspacePath)),
          file.map(({ heading }) => {
            const line = record.get(heading)?.line;
            return line === undefined ? { heading } : { heading, line };
          }),
        );
        const previousRaw =
          baseline && file.some((section) => !record.has(section.heading))
            ? await baseline(workspacePath)
            : undefined;
        const previous =
          previousRaw === undefined ? undefined : sectionFingerprints(previousRaw, file);
        for (const section of file) {
          const print = prints.get(section.heading)!;
          const recorded = record.get(section.heading);
          if (!recorded) {
            observed.set(sectionKey(section.path, section.heading), { ...section, ...print });
            const old = previous?.get(section.heading);
            if (old && old.fingerprint !== print.fingerprint)
              changed.set(sectionKey(section.path, section.heading), { ...section, ...print });
          } else if (recorded.fingerprint !== print.fingerprint) {
            changed.set(sectionKey(section.path, section.heading), { ...section, ...print });
            observed.set(sectionKey(section.path, section.heading), { ...section, ...print });
          }
        }
      };
      if (!(await withRecordLock(systemRoot, recordKey, () => observe(true)))) await observe(false);
    }),
  );
  return { changed, observed };
}

/**
 * The caller settles a changed section only after every Node that links it was named, and
 * only while the file still holds the version that write saw.
 */
export async function settleSections(
  systemRoot: string,
  workspaceRoot: string,
  sections: StopSections,
): Promise<void> {
  await Promise.all(
    [...byFile(sections.observed.values()).values()].map((file) =>
      withRecordLock(systemRoot, path.resolve(workspaceRoot, file[0]!.path), async () => {
        const now = sectionFingerprints(
          await readSectionSource(workspaceRoot, path.join(workspaceRoot, file[0]!.path)),
          file,
        );
        const settled = file.filter(
          (section) => now.get(section.heading)!.fingerprint === section.fingerprint,
        );
        if (settled.length)
          await appendRecord(systemRoot, path.resolve(workspaceRoot, file[0]!.path), settled);
      }),
    ),
  );
}
