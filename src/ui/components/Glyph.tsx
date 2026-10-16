import type { CSSProperties } from "react";
import { ICON_SVG, type IconName } from "./icons.js";
import { primaryOf, type Primary } from "../data/store.js";
import { fileOf, infoOf, useFiles, type FileKind } from "../data/files.js";
import type { SnapshotNode } from "../data/types.js";

/**
 * Type icons, drawn like the robot avatars. Goal is a pennant on a pole. Prompt and output share the robot's
 * rounded screen: prompt shows the `>_` handed to a session, output the return `↵` it hands back. Role is a robot
 * head, Card an envelope sealed in accent. The outer <svg> sets the line; see `glyphSvg`.
 */
export const TYPE_ICON_SVG: Record<Primary | "role" | "card", string> = {
  goal: '<g stroke="var(--goal)"><path d="M5 21.5V3"/><path d="M5 4h13.6a1.4 1.4 0 0 1 1.1 2.3L17 10l2.7 3.7a1.4 1.4 0 0 1-1.1 2.3H5" fill="var(--goal-fill)"/></g>',
  prompt:
    '<rect x="2.5" y="3.5" width="19" height="17" rx="5.5" stroke="var(--prompt)"/><path d="m7 8.5 3.5 3.5L7 15.5" stroke="var(--prompt)"/><path d="M12.5 15.5h4.5" stroke="var(--accent)"/>',
  output:
    '<g stroke="var(--output)"><rect x="2.5" y="3.5" width="19" height="17" rx="5.5"/><path d="M17 7.5v4a2.5 2.5 0 0 1-2.5 2.5H7"/><path d="m10.5 10.5-3.5 3.5 3.5 3.5"/></g>',
  role: '<g stroke="currentColor"><rect x="4.5" y="7.5" width="15" height="13" rx="4.5"/><path d="M12 7.5V5"/></g><circle cx="12" cy="3.6" r="1.5" fill="var(--accent)"/><circle cx="9.6" cy="13.8" r="1.25" fill="currentColor"/><circle cx="14.4" cy="13.8" r="1.25" fill="currentColor"/>',
  card: '<g stroke="currentColor"><rect x="3" y="5" width="18" height="14" rx="4.5"/><path d="m4 8.2 6.9 4.3a2 2 0 0 0 2.2 0L20 8.2"/></g><circle cx="12" cy="13.6" r="1.6" fill="var(--accent)"/>',
};

const GLYPH_ATTRS =
  'viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

/** A type icon as markup, for places that build HTML: rendered Markdown and the editor. */
export const glyphSvg = (kind: keyof typeof TYPE_ICON_SVG, size = 14) =>
  `<svg class="glyph glyph-${kind}" width="${size}" height="${size}" ${GLYPH_ATTRS}>${TYPE_ICON_SVG[kind]}</svg>`;

function Svg({
  kind,
  size,
  muted,
  style,
}: {
  kind: keyof typeof TYPE_ICON_SVG;
  size: number;
  muted?: boolean;
  style?: CSSProperties;
}) {
  return (
    <svg
      className={`glyph glyph-${kind}${muted ? " is-muted" : ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
      dangerouslySetInnerHTML={{ __html: TYPE_ICON_SVG[kind] }}
    />
  );
}

export function TypeGlyph({
  type,
  size = 15,
  muted = false,
  style,
}: {
  type: string | Primary;
  size?: number;
  muted?: boolean;
  style?: CSSProperties;
}) {
  return <Svg kind={primaryOf(type)} size={size} muted={muted} style={style} />;
}
/** A type icon standing for the object itself sits on a pale block of its type colour. */
export function TypeTile({ kind, size = 30 }: { kind: string; size?: number }) {
  const p = kind === "card" || kind === "draft" ? kind : primaryOf(kind);
  const glyph = Math.round(size * 0.5);
  return (
    <span className={`tile k-${p}`} style={{ width: size, height: size }}>
      {p === "draft" ? (
        <Icon name="draft" size={glyph} />
      ) : p === "card" ? (
        <Svg kind="card" size={glyph} />
      ) : (
        <Svg kind={p} size={glyph} />
      )}
    </span>
  );
}
export function CardGlyph({ size = 15 }: { size?: number }) {
  return <Svg kind="card" size={size} />;
}

export type { IconName };

/** Interface icons, one line weight everywhere; see icons.ts. */
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: ICON_SVG[name] }}
    />
  );
}

const FILE_ICONS: Record<FileKind, IconName> = {
  html: "fileHtml",
  image: "fileImage",
  pdf: "filePdf",
  video: "fileVideo",
  audio: "fileAudio",
  text: "fileText",
  other: "file",
};
/** A Node's own file, drawn by what its suffix shows in the Node's type colour; a missing file is crossed out. */
export function FileGlyph({
  show,
  missing,
  size = 14,
  kind,
}: {
  show: FileKind;
  missing?: boolean;
  size?: number;
  kind?: Primary;
}) {
  return (
    <span className={`file-glyph${kind ? ` p-${kind}` : ""}${missing ? " is-missing" : ""}`}>
      <Icon name={missing ? "fileMissing" : FILE_ICONS[show]} size={size} />
    </span>
  );
}

/** A Node's icon in lists: its file or remote address when its resource names one, otherwise its type. */
export function NodeGlyph({ node, size = 14 }: { node: SnapshotNode; size?: number }) {
  const files = useFiles();
  const file = fileOf(node);
  if (file?.kind === "uri")
    return (
      <span className="file-glyph is-remote">
        <Icon name="globe" size={size} />
      </span>
    );
  if (file?.kind !== "file") return <TypeGlyph type={node.type} size={size} />;
  return (
    <FileGlyph
      show={file.show}
      missing={infoOf(files, file.path) === null}
      size={size}
      kind={primaryOf(node.type)}
    />
  );
}
