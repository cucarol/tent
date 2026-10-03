import { useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, drawSelection, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type Completion,
  type CompletionContext,
} from "@codemirror/autocomplete";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { tags } from "@lezer/highlight";
import { primaryOf, type Graph } from "../data/store.js";
import type { SnapshotRef } from "../data/types.js";
import { t } from "../i18n.js";
import { relativeHref, resolveHref, workspaceImagePath } from "../util.js";
import { followLinks, livePreview, type RefKind } from "./livePreview.js";

type Props = {
  value: string;
  fromPath: string;
  graph: Graph;
  label: string;
  /** Hide Markdown markup away from the cursor. */
  live: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  /** Ctrl-click on a link to another Tent document. */
  onOpen: (ref: SnapshotRef) => void;
  onToast: (text: string) => void;
};

// Source stays byte-for-byte what was typed; styling only hints at how it will read.
const markdownStyle = HighlightStyle.define([
  // Same sizes as the reading view (20 / 17 / 15px on a 15px body).
  { tag: tags.heading1, fontSize: "1.333em", fontWeight: "600" },
  { tag: tags.heading2, fontSize: "1.133em", fontWeight: "600" },
  { tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6], fontWeight: "600" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  {
    tag: tags.link,
    textDecoration: "underline",
    textDecorationColor: "var(--border-strong)",
    textUnderlineOffset: "3px",
  },
  { tag: tags.url, color: "var(--text-3)" },
  {
    tag: [tags.processingInstruction, tags.contentSeparator, tags.labelName],
    color: "var(--text-3)",
  },
  { tag: tags.monospace, fontFamily: "var(--font-mono)", fontSize: ".88em" },
  { tag: tags.quote, color: "var(--text-2)" },
]);

const editorTheme = EditorView.theme({
  "&": {
    color: "var(--text)",
    backgroundColor: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: "8px",
    fontSize: "15px",
  },
  "&.cm-focused": {
    outline: "none",
    borderColor: "var(--border-strong)",
    boxShadow: "0 0 0 3px var(--bg-muted)",
  },
  ".cm-scroller": { fontFamily: "var(--font-sans)", lineHeight: "1.8" },
  ".cm-content": { padding: "14px 0", minHeight: "60vh", caretColor: "var(--text)" },
  ".cm-line": { padding: "0 18px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection":
    { backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent)" },
  ".cm-placeholder": { color: "var(--text-3)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--warn) 28%, transparent)" },
  ".cm-selectionMatch": { backgroundColor: "var(--bg-emphasis)" },
  ".cm-panels": { backgroundColor: "var(--bg-subtle)", color: "var(--text)" },
  ".cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-tooltip": {
    border: "1px solid var(--border)",
    backgroundColor: "var(--bg)",
    borderRadius: "8px",
    boxShadow: "var(--shadow-lg)",
    overflow: "hidden",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--font-sans)",
    fontSize: "13px",
    maxHeight: "16em",
    minWidth: "240px",
    padding: "4px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    padding: "5px 8px",
    borderRadius: "5px",
    lineHeight: "1.4",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--bg-emphasis)",
    color: "var(--text)",
  },
  // Live preview.
  ".cm-lp-code": { backgroundColor: "var(--bg-muted)", borderRadius: "4px", padding: "1px 4px" },
  ".cm-line.cm-lp-quote": {
    paddingLeft: "35px",
    color: "var(--text-2)",
    background:
      "linear-gradient(var(--border-strong), var(--border-strong)) 18px 0 / 3px 100% no-repeat",
  },
  ".cm-line.cm-lp-codeblock": {
    margin: "0 12px",
    padding: "0 14px",
    lineHeight: "1.6",
    backgroundColor: "var(--bg-subtle)",
    borderLeft: "1px solid var(--border)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-line.cm-lp-codeblock.is-first": {
    paddingTop: "8px",
    borderTop: "1px solid var(--border)",
    borderRadius: "8px 8px 0 0",
  },
  ".cm-line.cm-lp-codeblock.is-last": {
    paddingBottom: "8px",
    borderBottom: "1px solid var(--border)",
    borderRadius: "0 0 8px 8px",
  },
  ".cm-line.cm-lp-codeblock.is-first.is-last": { borderRadius: "8px" },
  // List items step in like the rendered page, and wrapped lines hang under the text.
  ".cm-line.cm-lp-li": {
    paddingLeft: "calc(18px + (var(--lp-depth, 0) + 1) * 1.4em)",
    textIndent: "-1.4em",
  },
  ".cm-lp-bullet": {
    display: "inline-block",
    width: "1.4em",
    paddingRight: ".55em",
    boxSizing: "border-box",
    textAlign: "right",
    textIndent: "0",
    color: "var(--text-3)",
  },
  ".cm-lp-task": {
    margin: "0 .4em 0 0",
    verticalAlign: "-2px",
    accentColor: "var(--text)",
    cursor: "pointer",
  },
  ".cm-lp-hr": {
    display: "inline-block",
    width: "100%",
    verticalAlign: "middle",
    borderTop: "1px solid var(--border-strong)",
  },
  ".cm-lp-ref": { fontWeight: "500" },
  ".cm-lp-glyph": { display: "inline-block", marginRight: "4px" },
  ".cm-lp-glyph svg": { transform: "translateY(1px)" },
  // Full width, so a picture without its own size (an SVG with only a viewBox) still has room.
  ".cm-lp-image": { display: "inline-block", width: "100%", verticalAlign: "top" },
  ".cm-lp-image img": {
    display: "block",
    maxWidth: "100%",
    maxHeight: "420px",
    margin: "6px 0",
    borderRadius: "6px",
    objectFit: "contain",
    objectPosition: "left",
  },
  ".cm-lp-table": { margin: "6px 18px", overflowX: "auto", cursor: "text" },
  ".cm-lp-table table": { borderCollapse: "collapse", fontSize: "13.5px", lineHeight: "1.6" },
  ".cm-lp-table th, .cm-lp-table td": {
    padding: "6px 10px",
    borderBottom: "1px solid var(--border)",
    textAlign: "left",
    verticalAlign: "top",
  },
  ".cm-lp-table th": { fontWeight: "600" },
  ".cm-lp-table a": {
    color: "var(--text)",
    textDecoration: "underline",
    textDecorationColor: "var(--border-strong)",
    textUnderlineOffset: "3px",
  },
  ".cm-lp-table code": {
    fontFamily: "var(--font-mono)",
    fontSize: ".88em",
    backgroundColor: "var(--bg-muted)",
    borderRadius: "4px",
    padding: "1px 4px",
  },
  // Holding Ctrl shows what a click would open.
  ".cm-follow .cm-md-link, .cm-follow .cm-md-url, .cm-follow .cm-lp-glyph, .cm-follow .cm-lp-image, .cm-follow .doc-file, .cm-follow .cm-lp-table a":
    { cursor: "pointer" },
  ".cm-follow .cm-md-link, .cm-follow .cm-md-url, .cm-follow .cm-lp-table a": {
    textDecorationColor: "var(--text-2)",
  },
  ".cm-completionDetail": {
    marginLeft: "10px",
    fontStyle: "normal",
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
    color: "var(--text-3)",
  },
});

/** The Tent document a link points at, if it exists. */
function refOf(graph: Graph, fromPath: string, href: string): SnapshotRef | null {
  const target = resolveHref(fromPath, href);
  const ref = target.tentPath ? graph.snapshot.paths[target.tentPath] : undefined;
  return ref && graph.exists(ref) ? ref : null;
}

/** What a link points at inside the workspace, so live preview can show the same glyph as the reading view. */
function refKindOf(graph: Graph, fromPath: string) {
  return (href: string): RefKind | null => {
    const ref = refOf(graph, fromPath, href);
    if (!ref) return null;
    return ref.kind === "node" ? primaryOf(graph.nodes.get(ref.id)!.type) : ref.kind;
  };
}

/** Typing [[ offers the workspace's Nodes and inserts a relative Markdown link to the chosen one. */
function nodeLinks(graph: Graph, fromPath: string) {
  return (context: CompletionContext) => {
    const typed = context.matchBefore(/\[\[[^\]\n]*$/);
    if (!typed) return null;
    const options: Completion[] = graph.snapshot.nodes.map((n) => ({
      label: `[[${n.name}`,
      displayLabel: n.name,
      detail: n.type,
      apply: (view, _completion, from, to) => {
        const text = `[${n.name}](${relativeHref(fromPath, n.notePath)})`;
        // closeBrackets may already have typed the matching "]]".
        const end = view.state.sliceDoc(to, to + 2) === "]]" ? to + 2 : to;
        view.dispatch({
          changes: { from, to: end, insert: text },
          selection: { anchor: from + text.length },
        });
      },
    }));
    return { from: typed.from, options };
  };
}

export default function MarkdownEditor({
  value,
  fromPath,
  graph,
  label,
  live,
  onChange,
  onSave,
  onOpen,
  onToast,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(null);
  const mode = useRef(new Compartment());
  const preview = useRef(
    livePreview(refKindOf(graph, fromPath), (src) => workspaceImagePath(fromPath, src)),
  );
  const latest = useRef({ onChange, onSave, onOpen, onToast });
  latest.current = { onChange, onSave, onOpen, onToast };

  const follow = (href: string) => {
    const ref = refOf(graph, fromPath, href);
    if (ref) return latest.current.onOpen(ref);
    const target = resolveHref(fromPath, href);
    if (target.external && /^(https?|mailto):/i.test(target.external))
      window.open(target.external, "_blank", "noopener");
    else if (target.file) latest.current.onToast(t.editor.fileOnly(target.file));
    else latest.current.onToast(t.editor.missing(target.tentPath ?? href));
  };

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          drawSelection(),
          indentOnInput(),
          closeBrackets(),
          highlightSelectionMatches(),
          search({ top: false }),
          markdown({ base: markdownLanguage }),
          syntaxHighlighting(markdownStyle),
          mode.current.of(live ? preview.current : []),
          followLinks(follow),
          autocompletion({ override: [nodeLinks(graph, fromPath)], icons: false }),
          placeholder(t.editor.placeholder),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": label, spellcheck: "false" }),
          editorTheme,
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                latest.current.onSave();
                return true;
              },
            },
            ...closeBracketsKeymap,
            ...completionKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...defaultKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    editor.focus();
    return () => editor.destroy();
    // The editor owns the draft once opened; later prop changes do not reset it.
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    editor.dispatch({ effects: mode.current.reconfigure(live ? preview.current : []) });
    editor.focus();
  }, [live]);

  return <div className="md-editor" ref={host} />;
}
