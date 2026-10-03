import { syntaxHighlighting, syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  Facet,
  type Line,
  type Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { tagHighlighter, tags } from "@lezer/highlight";
import type { SyntaxNode } from "@lezer/common";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { workspaceImage } from "../data/api.js";
import { t } from "../i18n.js";
import { loadableImage } from "../util.js";
import { TYPE_ICON_SVG, glyphSvg as typeSvg } from "./Glyph.js";

export type RefKind = keyof typeof TYPE_ICON_SVG;
type Follow = (href: string) => void;

const glyphSvg = (kind: RefKind) => typeSvg(kind, 14);

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const dot = document.createElement("span");
    dot.className = "cm-lp-bullet";
    dot.textContent = "•";
    return dot;
  }
}

class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(other: TaskWidget) {
    return other.checked === this.checked;
  }
  toDOM() {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-lp-task";
    box.checked = this.checked;
    box.setAttribute("aria-label", this.checked ? t.editor.taskDone : t.editor.taskOpen);
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

class RuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const rule = document.createElement("span");
    rule.className = "cm-lp-hr";
    return rule;
  }
}

class GlyphWidget extends WidgetType {
  constructor(readonly kind: RefKind) {
    super();
  }
  eq(other: GlyphWidget) {
    return other.kind === this.kind;
  }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "cm-lp-glyph";
    wrap.innerHTML = glyphSvg(this.kind);
    return wrap;
  }
  // Clicking the glyph edits the link, and Ctrl-clicking it follows the link, like its text.
  ignoreEvent() {
    return false;
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    /** Set for a Workspace image, which comes through the service. */
    readonly workspace?: string,
  ) {
    super();
  }
  eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt && other.workspace === this.workspace;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "cm-lp-image";
    const img = document.createElement("img");
    img.alt = this.alt;
    if (this.alt) img.title = this.alt;
    // The line grows once the picture arrives.
    img.addEventListener("load", () => view.requestMeasure());
    if (!this.workspace) img.src = this.src;
    else
      workspaceImage(this.workspace).then(
        (url) => (img.src = url),
        () => {
          wrap.replaceChildren(new FileWidget(this.src, this.alt).toDOM());
          view.requestMeasure();
        },
      );
    wrap.append(img);
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

class FileWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }
  eq(other: FileWidget) {
    return other.src === this.src && other.alt === this.alt;
  }
  toDOM() {
    const chip = document.createElement("span");
    chip.className = "doc-file";
    chip.title = t.doc.workspaceFile(this.src);
    chip.textContent = t.doc.image(this.alt || decodeURI(this.src).split("/").pop()!);
    return chip;
  }
  ignoreEvent() {
    return false;
  }
}

export type TableCell = { text: string; offset: number };
export type TableModel = { rows: TableCell[][]; align: Array<"left" | "center" | "right" | ""> };

/** Splits one table row into trimmed cells; a pipe escaped with a backslash stays in its cell. */
function splitRow(text: string, base: number): TableCell[] {
  const cells: TableCell[] = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      i++;
      continue;
    }
    if (ch !== undefined && ch !== "|") continue;
    const raw = text.slice(start, i);
    cells.push({ text: raw.trim(), offset: base + start + raw.length - raw.trimStart().length });
    start = i + 1;
  }
  // The outer pipes are optional.
  const trimmed = text.trim();
  if (trimmed.startsWith("|")) cells.shift();
  if (trimmed.length > 1 && trimmed.endsWith("|") && !trimmed.endsWith("\\|")) cells.pop();
  return cells;
}

/** A GFM table's cells with their offsets into the source, so a click on a cell can put the cursor there. */
export function tableModel(source: string): TableModel {
  const rows: TableCell[][] = [];
  let align: TableModel["align"] = [];
  let base = 0;
  source.split("\n").forEach((line, i) => {
    const cells = splitRow(line, base);
    base += line.length + 1;
    if (i === 1)
      align = cells.map((c) =>
        /^:-+:$/.test(c.text)
          ? "center"
          : /-:$/.test(c.text)
            ? "right"
            : /^:-/.test(c.text)
              ? "left"
              : "",
      );
    else if (line.trim()) rows.push(cells);
  });
  // Rows follow the header: short rows are padded and extra cells dropped.
  const width = rows[0]?.length ?? 0;
  return {
    rows: rows.map((r) =>
      Array.from(
        { length: width },
        (_, c) => r[c] ?? { text: "", offset: r[r.length - 1]?.offset ?? 0 },
      ),
    ),
    align,
  };
}

const followFacet = Facet.define<Follow, Follow | null>({ combine: (values) => values[0] ?? null });

class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly refKind: (href: string) => RefKind | null,
  ) {
    super();
  }
  eq(other: TableWidget) {
    return other.source === this.source;
  }
  get estimatedHeight() {
    return this.source.split("\n").length * 33;
  }
  toDOM(view: EditorView) {
    const { rows, align } = tableModel(this.source);
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-table";
    const table = document.createElement("table");
    rows.forEach((row, r) => {
      const tr = document.createElement("tr");
      row.forEach((cell, c) => {
        const td = document.createElement(r === 0 ? "th" : "td");
        td.dataset.offset = String(cell.offset);
        if (align[c]) td.style.textAlign = align[c];
        td.innerHTML = DOMPurify.sanitize(
          marked.parseInline(cell.text, { gfm: true, async: false }) as string,
        );
        td.querySelectorAll("a[href]").forEach((a) => {
          const kind = this.refKind(a.getAttribute("href")!);
          a.className = kind ? "cm-lp-ref" : "cm-lp-link";
          if (kind)
            a.insertAdjacentHTML(
              "afterbegin",
              `<span class="cm-lp-glyph">${glyphSvg(kind)}</span>`,
            );
        });
        tr.append(td);
      });
      (r === 0 ? table.createTHead() : (table.tBodies[0] ?? table.createTBody())).append(tr);
    });
    wrap.append(table);
    wrap.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const target = event.target as HTMLElement;
      const link = target.closest("a[href]");
      const follow = view.state.facet(followFacet);
      if (link && (event.ctrlKey || event.metaKey) && follow) {
        follow(link.getAttribute("href")!);
        return;
      }
      // Otherwise edit the table's source, with the cursor in the cell that was clicked.
      const start = view.posAtDOM(wrap);
      const offset = Number(target.closest<HTMLElement>("[data-offset]")?.dataset.offset ?? 0);
      // The editor reports focus a moment later; say it now, so the table opens in the same update that
      // moves the cursor and the active line lands on the clicked row rather than the table's first.
      view.focus();
      view.dispatch({
        selection: { anchor: Math.min(start + offset, view.state.doc.length) },
        effects: focusChanged.of(true),
      });
    });
    wrap.addEventListener("click", (event) => event.preventDefault());
    return wrap;
  }
}

const focusChanged = StateEffect.define<boolean>();

/** Tables replace whole lines, which only a state field may do. They show as tables until the cursor enters them. */
function tables(refKind: (href: string) => RefKind | null): Extension {
  const render = (state: EditorState, focused: boolean) => {
    const out: Range<Decoration>[] = [];
    syntaxTree(state).iterate({
      enter: (node) => {
        if (node.name !== "Table")
          return /^(Document|Blockquote|BulletList|OrderedList|ListItem)$/.test(node.name);
        const first = state.doc.lineAt(node.from);
        const last = state.doc.lineAt(node.to);
        const to = node.to === last.from && node.to > node.from ? node.to - 1 : last.to;
        const inside =
          focused && state.selection.ranges.some((r) => r.from <= to && r.to >= first.from);
        // A table inside a quote keeps its source, so the quote marks are not swallowed.
        if (!inside && !state.doc.sliceString(first.from, node.from).trim()) {
          out.push(
            Decoration.replace({
              widget: new TableWidget(state.doc.sliceString(first.from, to), refKind),
              block: true,
            }).range(first.from, to),
          );
        }
        return false;
      },
    });
    return Decoration.set(out);
  };
  const field = StateField.define<{ focused: boolean; decorations: DecorationSet }>({
    create: (state) => ({ focused: false, decorations: render(state, false) }),
    update(value, tr) {
      let focused = value.focused;
      for (const effect of tr.effects) if (effect.is(focusChanged)) focused = effect.value;
      if (
        focused === value.focused &&
        !tr.docChanged &&
        !tr.selection &&
        syntaxTree(tr.startState) === syntaxTree(tr.state)
      )
        return value;
      return { focused, decorations: render(tr.state, focused) };
    },
    provide: (f) => EditorView.decorations.from(f, (value) => value.decorations),
  });
  return [field, EditorView.focusChangeEffect.of((_state, focusing) => focusChanged.of(focusing))];
}

/**
 * Hides Markdown markup the selection is not touching, the way Obsidian's live preview does.
 * Only the display changes: the document keeps every character as written.
 */
type ImageOf = (src: string) => string | null;

function build(
  view: EditorView,
  refKind: (href: string) => RefKind | null,
  imageOf: ImageOf,
): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const out: Range<Decoration>[] = [];
  const hidden: [number, number][] = [];

  const touched = (from: number, to: number) =>
    view.hasFocus && state.selection.ranges.some((r) => r.from <= to && r.to >= from);
  const lineTouched = (pos: number) => {
    const line = doc.lineAt(pos);
    return touched(line.from, line.to);
  };
  const spaceAfter = (pos: number) => (doc.sliceString(pos, pos + 1) === " " ? pos + 1 : pos);
  // Only nodes wholly inside hidden markup; the document itself starts inside a hidden "## " too.
  const isHidden = (from: number, to: number) => hidden.some(([a, b]) => from >= a && to <= b);
  const hide = (from: number, to: number, widget?: WidgetType) => {
    // Plugins may not replace line breaks.
    if (from >= to || doc.lineAt(from).number !== doc.lineAt(to).number) return;
    out.push(Decoration.replace(widget ? { widget } : {}).range(from, to));
    hidden.push([from, to]);
  };
  const eachLine = (
    from: number,
    to: number,
    fn: (line: Line, first: boolean, last: boolean) => void,
  ) => {
    const a = doc.lineAt(from).number,
      b = doc.lineAt(to).number;
    for (let n = a; n <= b; n++) fn(doc.line(n), n === a, n === b);
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (isHidden(node.from, node.to)) return false;
        switch (node.name) {
          case "HeaderMark": {
            if (!node.node.parent?.name.startsWith("ATXHeading") || lineTouched(node.from)) break;
            const line = doc.lineAt(node.from);
            if (!doc.sliceString(line.from, node.from).trim()) {
              let end = node.to;
              while (doc.sliceString(end, end + 1) === " ") end++;
              hide(node.from, end);
            } else {
              let start = node.from;
              while (start > line.from && doc.sliceString(start - 1, start) === " ") start--;
              hide(start, node.to);
            }
            break;
          }
          case "EmphasisMark":
          case "StrikethroughMark": {
            const parent = node.node.parent;
            if (parent && !touched(parent.from, parent.to)) hide(node.from, node.to);
            break;
          }
          case "Escape":
            if (!touched(node.from, node.to)) hide(node.from, node.from + 1);
            break;
          case "InlineCode": {
            const open = node.node.firstChild,
              close = node.node.lastChild;
            if (touched(node.from, node.to) || !open || !close || open.from === close.from)
              out.push(inlineCode.range(node.from, node.to));
            else {
              if (open.to < close.from) out.push(inlineCode.range(open.to, close.from));
              hide(open.from, open.to);
              hide(close.from, close.to);
            }
            return false;
          }
          case "Blockquote":
            eachLine(node.from, node.to, (line) => out.push(quoteLine.range(line.from)));
            break;
          case "QuoteMark":
            if (!lineTouched(node.from)) hide(node.from, spaceAfter(node.to));
            break;
          case "ListMark": {
            if (node.node.parent?.parent?.name !== "BulletList") break;
            const line = doc.lineAt(node.from);
            let depth = 0;
            for (let p = node.node.parent.parent.parent; p; p = p.parent)
              if (p.name === "BulletList" || p.name === "OrderedList") depth++;
            out.push(
              Decoration.line({
                class: "cm-lp-li",
                attributes: { style: `--lp-depth: ${depth}` },
              }).range(line.from),
            );
            const task =
              node.node.nextSibling?.name === "Task"
                ? node.node.nextSibling.getChild("TaskMarker")
                : null;
            if (touched(node.from, spaceAfter(task ? task.to : node.to))) break;
            // The line's indent shows the nesting, so the spaces before the mark go.
            if (/^\s+$/.test(doc.sliceString(line.from, node.from))) hide(line.from, node.from);
            // A task item shows only its checkbox.
            if (task) hide(node.from, spaceAfter(node.to));
            else hide(node.from, spaceAfter(node.to), new BulletWidget());
            break;
          }
          case "TaskMarker": {
            const mark = node.node.parent?.prevSibling;
            const start = mark?.name === "ListMark" ? mark.from : node.from;
            if (touched(start, spaceAfter(node.to))) break;
            hide(
              node.from,
              node.to,
              new TaskWidget(/x/i.test(doc.sliceString(node.from + 1, node.to - 1))),
            );
            break;
          }
          case "HorizontalRule":
            if (!lineTouched(node.from)) hide(node.from, node.to, new RuleWidget());
            break;
          case "FencedCode":
          case "CodeBlock":
            eachLine(node.from, node.to, (line, first, last) =>
              out.push(
                Decoration.line({
                  class: `cm-lp-codeblock${first ? " is-first" : ""}${last ? " is-last" : ""}`,
                }).range(line.from),
              ),
            );
            return false;
          // A rendered table is drawn by the tables field.
          case "Table":
            if (!touched(doc.lineAt(node.from).from, node.to)) return false;
            break;
          case "Image": {
            const url = node.node.getChild("URL");
            const marks = node.node.getChildren("LinkMark");
            const close = marks.find((m) => doc.sliceString(m.from, m.to) === "]");
            if (!url || !marks[0] || !close) break;
            const src = doc.sliceString(url.from, url.to).replace(/^<|>$/g, "");
            const alt = doc.sliceString(marks[0].to, close.from);
            const workspace = loadableImage(src) ? undefined : (imageOf(src) ?? undefined);
            const image =
              loadableImage(src) || workspace ? new ImageWidget(src, alt, workspace) : null;
            // While it is being edited the picture stays below its source, so the text does not jump.
            if (touched(node.from, node.to)) {
              if (image) out.push(Decoration.widget({ widget: image, side: 1 }).range(node.to));
            } else hide(node.from, node.to, image ?? new FileWidget(src, alt));
            return false;
          }
          case "Link": {
            if (touched(node.from, node.to)) break;
            const marks = node.node.getChildren("LinkMark");
            const open = marks[0];
            const close = marks.find((m) => doc.sliceString(m.from, m.to) === "]");
            // Leave shortcut references like [text] alone; there is nothing to hide.
            if (
              !open ||
              doc.sliceString(open.from, open.to) !== "[" ||
              !close ||
              close.to === node.to
            )
              break;
            const url = node.node.getChild("URL");
            const href = url ? doc.sliceString(url.from, url.to).replace(/^<|>$/g, "") : "";
            const kind = href ? refKind(href) : null;
            hide(open.from, open.to, kind ? new GlyphWidget(kind) : undefined);
            hide(close.from, node.to);
            if (open.to < close.from)
              out.push(
                Decoration.mark({
                  class: kind ? "cm-lp-ref" : "cm-lp-link",
                  attributes: href ? { title: `${href}\n${t.editor.followHint}` } : {},
                }).range(open.to, close.from),
              );
            break;
          }
        }
        return undefined;
      },
    });
  }
  return Decoration.set(out, true);
}

const inlineCode = Decoration.mark({ class: "cm-lp-code" });
const quoteLine = Decoration.line({ class: "cm-lp-quote" });

/** Ticks a task checkbox by rewriting only its marker. */
const taskToggle = EditorView.domEventHandlers({
  mousedown(event, view) {
    const box = event.target;
    if (!(box instanceof HTMLInputElement) || !box.classList.contains("cm-lp-task")) return false;
    event.preventDefault();
    const pos = view.posAtDOM(box);
    const marker = view.state.sliceDoc(pos, pos + 3);
    if (/^\[[ xX]\]$/.test(marker))
      view.dispatch({
        changes: { from: pos + 1, to: pos + 2, insert: marker[1] === " " ? "x" : " " },
      });
    return true;
  },
});

/** `imageOf` gives a Workspace image's path for the service, or null when it cannot be shown. */
export function livePreview(
  refKind: (href: string) => RefKind | null,
  imageOf: ImageOf = () => null,
): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, refKind, imageOf);
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          update.focusChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state)
        ) {
          this.decorations = build(update.view, refKind, imageOf);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
  return [plugin, tables(refKind), taskToggle];
}

/** The link under a position; a link wrapped around an image wins over the image. */
function hrefAt(state: EditorState, pos: number): string | null {
  const tree = syntaxTree(state);
  for (const side of [1, -1] as const) {
    let found: string | null = null;
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
      const url =
        node.name === "URL"
          ? node
          : /^(Link|Image|Autolink)$/.test(node.name)
            ? node.getChild("URL")
            : null;
      if (url && (found === null || node.name === "Link"))
        found = state.sliceDoc(url.from, url.to).replace(/^<|>$/g, "");
    }
    if (found) return found;
  }
  return null;
}

const isMod = (event: MouseEvent | KeyboardEvent) => event.ctrlKey || event.metaKey;
const isModKey = (event: KeyboardEvent) => event.key === "Control" || event.key === "Meta";

/** Ctrl-click (⌘-click on a Mac) follows a link in either mode; holding the key shows which text is a link. */
export function followLinks(follow: Follow): Extension {
  return [
    followFacet.of(follow),
    syntaxHighlighting(
      tagHighlighter([
        { tag: tags.link, class: "cm-md-link" },
        { tag: tags.url, class: "cm-md-url" },
      ]),
    ),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (!isMod(event) || event.button !== 0) return false;
        if (
          !(event.target as HTMLElement).closest(
            ".cm-md-link, .cm-md-url, .cm-lp-glyph, .cm-lp-image, .doc-file",
          )
        )
          return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        const href = pos === null ? null : hrefAt(view.state, pos);
        if (!href) return false;
        event.preventDefault();
        follow(href);
        return true;
      },
      // The class sits on the scroller, whose classes the editor does not rewrite.
      mousemove(event, view) {
        view.scrollDOM.classList.toggle("cm-follow", isMod(event));
      },
      keydown(event, view) {
        if (isModKey(event)) view.scrollDOM.classList.add("cm-follow");
      },
      keyup(event, view) {
        if (isModKey(event)) view.scrollDOM.classList.remove("cm-follow");
      },
      blur(_event, view) {
        view.scrollDOM.classList.remove("cm-follow");
      },
    }),
  ];
}
