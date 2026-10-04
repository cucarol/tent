import type { CSSProperties } from "react";
import {
  ArrowDown,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Copy,
  File,
  FileText,
  FolderOpen,
  Globe,
  GripVertical,
  History,
  Link,
  LocateFixed,
  Lock,
  Mail,
  MailPlus,
  Maximize2,
  Minimize2,
  Minus,
  Moon,
  PanelLeft,
  Pause,
  PencilLine,
  Play,
  Plus,
  Scan,
  Search,
  SendHorizontal,
  Settings,
  Spline,
  SquarePen,
  SquarePlus,
  Sun,
  UsersRound,
  Waypoints,
  X,
  type LucideIcon,
} from "lucide-react";
import { primaryOf, type Primary } from "../data/store.js";

/**
 * Type icons from Lucide, so they sit with the interface icons: goal is a flag, prompt the prompt `>_`,
 * output a package. Role is an id card (a direction of work, not a person) and Card an envelope.
 * The outer <svg> sets the line; see `glyphSvg`.
 */
export const TYPE_ICON_SVG: Record<Primary | "role" | "card", string> = {
  goal: '<path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528" stroke="var(--goal)"/>',
  prompt:
    '<path d="M12 19h8" stroke="var(--prompt)"/><path d="m4 17 6-6-6-6" stroke="var(--prompt)"/>',
  output:
    '<g stroke="var(--output)"><path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><polyline points="3.29 7 12 12 20.71 7"/><path d="m7.5 4.27 9 5.15"/></g>',
  role: '<g stroke="currentColor"><path d="M13 19a4 4 0 0 0-8 0"/><path d="M16 10h2"/><path d="M16 14h2"/><circle cx="9" cy="12" r="3"/><rect x="2" y="5" width="20" height="14" rx="2"/></g>',
  card: '<path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7" stroke="currentColor"/><rect x="2" y="4" width="20" height="16" rx="2" stroke="currentColor"/>',
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
        <Icon name="edit" size={glyph} />
      ) : p === "card" ? (
        <Svg kind="card" size={glyph} />
      ) : (
        <Svg kind={p} size={glyph} />
      )}
    </span>
  );
}
export function RoleGlyph({ size = 15 }: { size?: number }) {
  return <Svg kind="role" size={size} />;
}
export function CardGlyph({ size = 15 }: { size?: number }) {
  return <Svg kind="card" size={size} />;
}

/** Interface icons: Lucide (ISC), one line weight everywhere. */
const icons = {
  search: Search,
  compose: SquarePen,
  plus: Plus,
  minus: Minus,
  sun: Sun,
  moon: Moon,
  close: X,
  fit: Scan,
  place: SquarePlus,
  edit: PencilLine,
  copy: Copy,
  chevron: ChevronRight,
  down: ChevronDown,
  locate: LocateFixed,
  sidebar: PanelLeft,
  expand: Maximize2,
  shrink: Minimize2,
  link: Link,
  refs: Spline,
  lens: Waypoints,
  clock: History,
  help: CircleHelp,
  play: Play,
  pause: Pause,
  globe: Globe,
  file: File,
  out: ArrowUpRight,
  mail: Mail,
  addToCard: MailPlus,
  settings: Settings,
  public: UsersRound,
  grip: GripVertical,
  send: SendHorizontal,
  check: Check,
  drop: ArrowDown,
  lock: Lock,
  text: FileText,
  folder: FolderOpen,
} satisfies Record<string, LucideIcon>;
export type IconName = keyof typeof icons;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const Glyph = icons[name];
  return <Glyph className="icon" size={size} strokeWidth={1.75} aria-hidden="true" />;
}
