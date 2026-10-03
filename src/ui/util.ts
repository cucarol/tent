import { t } from "./i18n.js";

export const shortHash = (hash: string | undefined) => (hash ?? "").slice(0, 7);

export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 86400000);
  if (diff === 0) return t.time.today;
  if (diff === 1) return t.time.yesterday;
  return d.toLocaleDateString(t.code, { month: "long", day: "numeric" });
}
export const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString(t.code, { hour: "2-digit", minute: "2-digit", hour12: false });
export const when = (iso: string | null | undefined) =>
  iso ? `${dayLabel(iso)} ${timeOf(iso)}` : "—";

/** Short relative time for dense places like map cards. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const minutes = Math.floor((now - Date.parse(iso)) / 60000);
  if (minutes < 1) return t.time.justNow;
  if (minutes < 60) return t.time.minutesAgo(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t.time.hoursAgo(hours);
  const days = Math.floor(hours / 24);
  if (days < 30) return t.time.daysAgo(days);
  return new Date(iso).toLocaleDateString(t.code, { month: "numeric", day: "numeric" });
}

function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
    } else out.push(part);
  }
  return out.join("/");
}

/** Resolve a Markdown link from a document inside .tent to a Tent path or a Workspace file. */
export function resolveHref(
  fromPath: string,
  href: string,
): { external?: string; tentPath?: string; file?: string } {
  if (/^[a-z][a-z\d+.-]*:/i.test(href)) return { external: href };
  let clean = href.split(/[?#]/)[0] ?? "";
  try {
    clean = decodeURIComponent(clean);
  } catch {
    /* keep raw */
  }
  const dir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const full = normalize(
    clean.startsWith("/") ? `.tent/${clean.slice(1)}` : `.tent/${dir}/${clean}`,
  );
  return full.startsWith(".tent/") ? { tentPath: full.slice(6) } : { file: full };
}

/** Images the page can load by address; Workspace images come through the tent ui service. */
export const loadableImage = (src: string) => /^(https?:|data:image\/)/i.test(src);

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;
/** A document's image as a Workspace-relative path the service can show, or null. */
export function workspaceImagePath(fromPath: string, src: string): string | null {
  const target = resolveHref(fromPath, src);
  if (target.external) return null;
  const path = target.tentPath !== undefined ? `.tent/${target.tentPath}` : target.file;
  return path && !path.startsWith("../") && IMAGE_FILE.test(path) ? path : null;
}

/** The relative link from one document inside .tent to another, as resolveHref reads it back. */
export function relativeHref(fromPath: string, toPath: string): string {
  const from = fromPath.split("/").slice(0, -1),
    to = toPath.split("/");
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  const up = from.length - common;
  const rest = to.slice(common).join("/").replace(/ /g, "%20");
  return up ? `${"../".repeat(up)}${rest}` : `./${rest}`;
}

export function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
export function writeStored(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

/**
 * Line diff as patch lines: " " kept, "-" only in `before`, "+" only in `after`. Unchanged runs
 * keep `context` lines around each change, and an "@@" line marks what was left out.
 */
export function lineDiff(before: string, after: string, context = 2): string {
  const lines = fullDiff(before, after);
  const near = lines.map(() => false);
  lines.forEach((line, i) => {
    if (line[0] === " ") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++)
      near[k] = true;
  });
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (near[i]) out.push(line);
    else if (near[i - 1] !== false || i === 0) out.push("@@ …");
  });
  return out.join("\n");
}

export type Segment = { kind: "same" | "del" | "ins"; text: string };

// Words stay whole; each CJK character, space run or other symbol is its own token.
const TOKEN = /[A-Za-z0-9_]+|\s+|[^A-Za-z0-9_\s]/gu;

/**
 * One edited line as kept, removed and added pieces, for reading a change in place. Null when the
 * two lines share too little for that to help (they read better as a removed and an added line)
 * or are too long to compare.
 */
export function inlineDiff(before: string, after: string): Segment[] | null {
  const a = before.match(TOKEN) ?? [],
    b = after.match(TOKEN) ?? [];
  if (a.length * b.length > 1_000_000) return null;
  const common = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      common[i]![j] =
        a[i] === b[j]
          ? common[i + 1]![j + 1]! + 1
          : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
  const out: Segment[] = [];
  const push = (kind: Segment["kind"], text: string) => {
    const last = out.at(-1);
    if (last?.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  let i = 0,
    j = 0,
    kept = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      kept += a[i]!.length;
      push("same", a[i++]!);
      j++;
    } else if (j >= b.length || (i < a.length && common[i + 1]![j]! >= common[i]![j + 1]!))
      push("del", a[i++]!);
    else push("ins", b[j++]!);
  }
  return (2 * kept) / (before.length + after.length || 1) >= 0.5 ? out : null;
}

/**
 * Long unchanged stretches of an edited line cut down to what sits next to a change, so a small
 * edit in a long paragraph is visible without scrolling.
 */
export function trimSegments(segments: Segment[], keep = 30): Segment[] {
  return segments.map((s, i) => {
    const chars = [...s.text];
    if (s.kind !== "same") return s;
    const first = i === 0,
      last = i === segments.length - 1;
    if (first && !last && chars.length > keep + 10)
      return { ...s, text: `…${chars.slice(-keep).join("")}` };
    if (last && !first && chars.length > keep + 10)
      return { ...s, text: `${chars.slice(0, keep).join("")}…` };
    if (!first && !last && chars.length > 2 * keep + 10)
      return {
        ...s,
        text: `${chars.slice(0, keep).join("")} … ${chars.slice(-keep).join("")}`,
      };
    return s;
  });
}

function fullDiff(before: string, after: string): string[] {
  const a = before.split("\n"),
    b = after.split("\n");
  // Very long documents skip the table and show one side after the other.
  if (a.length * b.length > 4_000_000)
    return [...a.map((line) => `-${line}`), ...b.map((line) => `+${line}`)];
  const common = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      common[i]![j] =
        a[i] === b[j]
          ? common[i + 1]![j + 1]! + 1
          : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
  const out: string[] = [];
  let i = 0,
    j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i++;
      j++;
    } else if (common[i + 1]![j]! >= common[i]![j + 1]!) out.push(`-${a[i++]}`);
    else out.push(`+${b[j++]}`);
  }
  while (i < a.length) out.push(`-${a[i++]}`);
  while (j < b.length) out.push(`+${b[j++]}`);
  return out;
}

/** A long folder path keeps its end, where the folders that tell workspaces apart are. */
export function pathTail(root: string, room = 38): string {
  if (root.length <= room) return root;
  const sep = root.includes("\\") ? "\\" : "/";
  const parts = root.split(/[\\/]/);
  let tail = parts.pop()!;
  while (parts.length && tail.length + parts[parts.length - 1]!.length + 1 <= room)
    tail = `${parts.pop()}${sep}${tail}`;
  return `…${sep}${tail}`;
}
