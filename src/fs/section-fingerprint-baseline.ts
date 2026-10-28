import path from "node:path";
import { parseFrontmatter } from "../core/base/frontmatter.js";
import { findSection } from "../core/base/markdown-section.js";
import { sectionFingerprints, type SectionTarget } from "../core/return/section-fingerprint.js";
import type { StopMaterialIndex } from "../core/return/stop-material-index.js";
import { byFile, readText, replaceRecord, withRecordLock } from "./section-fingerprints.js";

/** The heading line Core's parser selects, which the tool hook's line scan then finds exactly. */
function headingLine(raw: string, heading: string): string | undefined {
  try {
    return findSection(parseFrontmatter(raw).body, heading)?.text.split("\n", 1)[0]!.trim();
  } catch {
    return undefined;
  }
}

/**
 * SessionStart records every linked section as it stands, so a later write names only
 * sections it changed. It runs with Core's parser; the tool hook does not.
 */
export async function recordSectionFingerprints(
  systemRoot: string,
  workspaceRoot: string,
  index: StopMaterialIndex,
): Promise<void> {
  const files = [
    ...byFile(
      index.nodes.flatMap((node) =>
        node.materialFiles.flatMap((file) =>
          file.heading === undefined ? [] : [{ path: file.path, heading: file.heading }],
        ),
      ),
    ).values(),
  ];
  for (let start = 0; start < files.length; start += 64)
    await Promise.all(
      files.slice(start, start + 64).map((sections) =>
        withRecordLock(systemRoot, sections[0]!.path, async () => {
          const raw = await readText(path.join(workspaceRoot, sections[0]!.path));
          const targets: SectionTarget[] = [...new Set(sections.map(({ heading }) => heading))].map(
            (heading) => {
              const line = raw === undefined ? undefined : headingLine(raw, heading);
              return line === undefined ? { heading } : { heading, line };
            },
          );
          const prints = sectionFingerprints(raw, targets);
          await replaceRecord(
            systemRoot,
            sections[0]!.path,
            targets.map(({ heading }) => ({ heading, ...prints.get(heading)! })),
          );
        }),
      ),
    );
}
