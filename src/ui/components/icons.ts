/*!
 * Interface icons as SVG markup on a 24 grid, drawn with the robot avatars' hand: round caps, the big corner of the
 * robot's head on square shapes, and at most one accent mark. Tent's own things (Card, draft, region, files) are drawn
 * here; the familiar controls keep the shapes of Lucide, under its licence:
 *
 * ISC License. Copyright (c) 2026 Lucide Icons and Contributors. Permission to use, copy, modify, and/or distribute
 * this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and
 * this permission notice appear in all copies. THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL
 * WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT
 * SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER
 * RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
 * ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */
export const ICON_SVG = {
  search: '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>',
  compose:
    '<path d="M11.5 3.5H8A4.5 4.5 0 0 0 3.5 8v8A4.5 4.5 0 0 0 8 20.5h8a4.5 4.5 0 0 0 4.5-4.5v-3.5"/><path d="M18.4 2.6a2.1 2.1 0 0 1 3 3L12.5 14.5l-4 1 1-4z"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  minus: '<path d="M5 12h14"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  fit: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/>',
  place:
    '<rect x="3.5" y="3.5" width="17" height="17" rx="5.5"/><path d="M12 8.5v7"/><path d="M8.5 12h7"/>',
  edit: '<path d="M13 21h8"/><path d="m15 5 4 4"/><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="3.5"/><path d="M16 8V6.5A3.5 3.5 0 0 0 12.5 3h-6A3.5 3.5 0 0 0 3 6.5v6A3.5 3.5 0 0 0 6.5 16H8"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  locate:
    '<line x1="2" x2="5" y1="12" y2="12"/><line x1="19" x2="22" y1="12" y2="12"/><line x1="12" x2="12" y1="2" y2="5"/><line x1="12" x2="12" y1="19" y2="22"/><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3"/>',
  sidebar: '<rect x="3" y="3.5" width="18" height="17" rx="5"/><path d="M9.5 3.5v17"/>',
  expand: '<path d="M15 3h6v6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/><path d="M9 21H3v-6"/>',
  shrink: '<path d="m14 10 7-7"/><path d="M20 10h-6V4"/><path d="m3 21 7-7"/><path d="M4 14h6v6"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  lens: '<path d="m10.586 5.414-5.172 5.172"/><path d="m18.586 13.414-5.172 5.172"/><path d="M6 12h12"/><circle cx="12" cy="20" r="2"/><circle cx="12" cy="4" r="2"/><circle cx="20" cy="12" r="2"/><circle cx="4" cy="12" r="2"/>',
  clock:
    '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  play: '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>',
  pause:
    '<rect x="14" y="3" width="5" height="18" rx="1"/><rect x="5" y="3" width="5" height="18" rx="1"/>',
  globe:
    '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  file: '<path d="M8 3h5.5L19 8.5V18a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z"/><path d="M13.5 3.2v3.3a2 2 0 0 0 2 2h3.3"/>',
  fileHtml:
    '<path d="M8 3h5.5L19 8.5V18a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z"/><path d="M13.5 3.2v3.3a2 2 0 0 0 2 2h3.3"/><path d="m10 12.5-2 2 2 2"/><path d="m14 12.5 2 2-2 2"/>',
  fileImage:
    '<path d="M8 3h5.5L19 8.5V18a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z"/><path d="M13.5 3.2v3.3a2 2 0 0 0 2 2h3.3"/><circle cx="9.5" cy="12" r="1.5"/><path d="m5.5 19 4-3.6a1.6 1.6 0 0 1 2.1 0L18.6 21"/>',
  fileVideo:
    '<path d="M8 3h5.5L19 8.5V18a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z"/><path d="M13.5 3.2v3.3a2 2 0 0 0 2 2h3.3"/><path d="M10.5 12.2v4.6l3.8-2.3z"/>',
  fileAudio:
    '<path d="M8 3h5.5L19 8.5V18a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z"/><path d="M13.5 3.2v3.3a2 2 0 0 0 2 2h3.3"/><circle cx="10" cy="17" r="1.6"/><path d="M11.6 17v-5.2l3.4-1"/>',
  fileText:
    '<path d="M8 3h5.5L19 8.5V18a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z"/><path d="M13.5 3.2v3.3a2 2 0 0 0 2 2h3.3"/><path d="M8.5 13h7"/><path d="M8.5 16.5h5"/>',
  filePdf:
    '<path d="M8 3h5.5L19 8.5V18a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z"/><path d="M13.5 3.2v3.3a2 2 0 0 0 2 2h3.3"/><path d="M9 12.5h6"/><path d="M12 12.5V18"/>',
  preview:
    '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  unpreview:
    '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
  fileMissing:
    '<path d="M8 3h5.5L19 8.5V18a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z"/><path d="M13.5 3.2v3.3a2 2 0 0 0 2 2h3.3"/><path d="m9.5 12.5 5 5"/><path d="m14.5 12.5-5 5"/>',
  out: '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="4.5"/><path d="m4 8.2 6.9 4.3a2 2 0 0 0 2.2 0L20 8.2"/><circle cx="12" cy="13.6" r="1.6" fill="var(--accent)" stroke="none"/>',
  working:
    '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  returned:
    '<path d="M3 11.5V14.5A4.5 4.5 0 0 0 7.5 19h9a4.5 4.5 0 0 0 4.5-4.5v-5A4.5 4.5 0 0 0 16.5 5H12"/><path d="m11 12.4 2 1.3a2 2 0 0 0 2.2 0L20 10.6"/><path d="M6.5 2.5 3 6l3.5 3.5"/><path d="M3 6h5.5a3 3 0 0 1 3 3"/><circle cx="14.1" cy="15.4" r="1.4" fill="var(--accent)" stroke="none"/>',
  addToCard:
    '<path d="M21 12.5v-3A4.5 4.5 0 0 0 16.5 5h-9A4.5 4.5 0 0 0 3 9.5v5A4.5 4.5 0 0 0 7.5 19H13"/><path d="m4 8.2 6.9 4.3a2 2 0 0 0 2.2 0L20 8.2"/><path d="M19 15v6"/><path d="M16 18h6"/>',
  settings:
    '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>',
  grip: '<circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/>',
  send: '<path d="M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.842 7.627a.498.498 0 0 0 .682.627l18-8.5a.5.5 0 0 0 0-.904z"/><path d="M6 12h16"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  drop: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  text: '<path d="M8 3h5.5L19 8.5V18a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z"/><path d="M13.5 3.2v3.3a2 2 0 0 0 2 2h3.3"/><path d="M8.5 13h7"/><path d="M8.5 16.5h5"/>',
  folder:
    '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  pointer:
    '<path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/>',
  pen: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  type: '<path d="M12 4v16"/><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2"/><path d="M9 20h6"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13"/>',
  map: '<rect x="3" y="4" width="6" height="5" rx="1.6"/><rect x="15" y="4" width="6" height="5" rx="1.6"/><rect x="15" y="15" width="6" height="5" rx="1.6"/><path d="M9 6.5h6M12 6.5v11h3"/>',
  region: '<rect x="3.5" y="3.5" width="17" height="17" rx="5.5" stroke-dasharray="3 3.2"/>',
  ungroup:
    '<rect x="11" y="14" width="10" height="7" rx="2"/><rect x="3" y="3" width="10" height="7" rx="2"/>',
  draft:
    '<rect x="3" y="5" width="18" height="14" rx="4.5" stroke-dasharray="3.6 3.2"/><path d="m4 8.2 6.9 4.3a2 2 0 0 0 2.2 0L20 8.2"/>',
  // The pen's tools and the drawing panel.
  unlock:
    '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
  rect: '<rect x="3.5" y="5" width="17" height="14" rx="4.5"/>',
  diamond:
    '<path d="M10.6 3.6a2 2 0 0 1 2.8 0l7 7a2 2 0 0 1 0 2.8l-7 7a2 2 0 0 1-2.8 0l-7-7a2 2 0 0 1 0-2.8z"/>',
  ellipse: '<circle cx="12" cy="12" r="8.5"/>',
  arrow: '<path d="M4 12h16"/><path d="m14 6 6 6-6 6"/>',
  line: '<path d="M4 12h16"/>',
  eraser:
    '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
  toFront: '<path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M5 4h14"/>',
  forward: '<path d="M12 19V6"/><path d="m7 11 5-5 5 5"/>',
  backward: '<path d="M12 5v13"/><path d="m7 13 5 5 5-5"/>',
  toBack: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/>',
  download:
    '<path d="M12 15V3"/><path d="m7 10 5 5 5-5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>',
} as const;
export type IconName = keyof typeof ICON_SVG;
