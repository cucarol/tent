// Small pieces of the map's pointer handling, kept apart so they can be checked without a browser.

/** The zoom that fits a box of `w` by `h` into `room`, held between `min` and the lower of `max` and 1. */
export function fitZoom(
  w: number,
  h: number,
  room: { w: number; h: number },
  max: number,
  min: number,
) {
  // Never past 100%, whatever a caller asks: closer in shows nothing more.
  return Math.min(max, 1, Math.max(min, Math.min(room.w / w, room.h / h)));
}

/**
 * Whether Space is held, so the left button moves the map. A window losing focus never hears the key go
 * up, so leaving it lets go of the key too.
 */
export function watchSpace(win: Pick<Window, "addEventListener" | "removeEventListener">) {
  let held = false;
  const on = (e: Event) => {
    if ((e as KeyboardEvent).key === " ") held = e.type === "keydown";
  };
  const off = () => (held = false);
  win.addEventListener("keydown", on);
  win.addEventListener("keyup", on);
  win.addEventListener("blur", off);
  return {
    held: () => held,
    stop() {
      win.removeEventListener("keydown", on);
      win.removeEventListener("keyup", on);
      win.removeEventListener("blur", off);
    },
  };
}
