// A picture of the map as it stands, topics and drawings as they look, saved as a PNG: for the
// person, and for an Agent that reads images, since the canvas file holds only places and words.
// Rules: Tent Node "UI-图谱画模块依赖与状态", "画笔 v10" and "画笔进图谱：按钮位置" (cuca 2026-10-17).

/** What is over the map rather than on it: controls, panels, popovers and selection marks. */
const LEAVE_OUT = [
  ".panel",
  ".react-flow__panel",
  ".react-flow__attribution",
  ".react-flow__minimap",
  ".react-pop",
  ".map-selection-reaction",
  ".map-focus-path",
  ".map-focus-menu",
  ".map-marquee",
  ".ink-pick",
].join(",");

export type Crop = { x: number; y: number; w: number; h: number };

/** The page's own style rules, as text the picture carries with it. */
function rules(): string {
  let out = "";
  for (const sheet of [...document.styleSheets]) {
    try {
      for (const r of [...sheet.cssRules]) out += `${r.cssText}\n`;
    } catch {
      // Another origin's sheet cannot be read; the picture goes without it.
    }
  }
  return out;
}

/** Custom properties as they resolve now, so the picture keeps the theme in use. */
function tokens(): string {
  const cs = getComputedStyle(document.documentElement);
  let out = "";
  for (let i = 0; i < cs.length; i++) {
    const p = cs[i]!;
    if (p.startsWith("--")) out += `${p}:${cs.getPropertyValue(p)};`;
  }
  return out;
}

/** The first background behind `el` that is not see-through. */
function groundOf(el: Element | null): string {
  for (; el; el = el.parentElement) {
    const bg = getComputedStyle(el).backgroundColor;
    if (bg && bg !== "transparent" && !/rgba\(.*,\s*0\)$/.test(bg)) return bg;
  }
  return "#fff";
}

const asData = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

/** Images a picture cannot fetch on its own, carried inside it. */
async function carryImages(root: HTMLElement) {
  await Promise.all(
    [...root.querySelectorAll("img")].map(async (img) => {
      if (!img.src || img.src.startsWith("data:")) return;
      try {
        img.src = await asData(await (await fetch(img.src)).blob());
      } catch {
        img.remove();
      }
    }),
  );
}

/**
 * `el` drawn as it looks, without what floats over it, cut to `crop` (in pixels from its top left) and
 * at twice the size for sharp text.
 */
export async function pictureOf(el: HTMLElement, crop?: Crop, scale = 2): Promise<Blob> {
  const at = el.getBoundingClientRect();
  const w = Math.round(at.width),
    h = Math.round(at.height);
  const ground = groundOf(el);
  const look = getComputedStyle(el);
  const copy = el.cloneNode(true) as HTMLElement;
  for (const n of copy.querySelectorAll(LEAVE_OUT)) n.remove();
  for (const n of copy.querySelectorAll(".is-picked")) n.classList.remove("is-picked");
  await carryImages(copy);
  copy.style.position = "relative";
  copy.style.width = `${w}px`;
  copy.style.height = `${h}px`;
  const page = document.createElement("div");
  page.setAttribute(
    "style",
    `${tokens()}width:${w}px;height:${h}px;overflow:hidden;background:${ground};` +
      `font-family:${look.fontFamily};color:${look.color};`,
  );
  const style = document.createElement("style");
  style.textContent = rules();
  page.append(style, copy);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w * scale}" height="${h * scale}" viewBox="0 0 ${w} ${h}">` +
    `<foreignObject x="0" y="0" width="${w}" height="${h}">${new XMLSerializer().serializeToString(page)}</foreignObject></svg>`;
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const c = crop ?? { x: 0, y: 0, w, h };
  const x = Math.max(0, c.x),
    y = Math.max(0, c.y),
    cw = Math.min(w, c.x + c.w) - x,
    ch = Math.min(h, c.y + c.h) - y;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(cw * scale);
  canvas.height = Math.round(ch * scale);
  const g = canvas.getContext("2d")!;
  g.fillStyle = ground;
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(img, x * scale, y * scale, cw * scale, ch * scale, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("no picture"))), "image/png"),
  );
}

/** Hands a file to the browser to save. */
export function saveFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A file name that sorts by when it was taken, in local time. */
export function pictureName(workspace: string, now = new Date()) {
  const two = (n: number) => String(n).padStart(2, "0");
  const when = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}`;
  const base = workspace.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "tent";
  return `${base}-map-${when}.png`;
}
