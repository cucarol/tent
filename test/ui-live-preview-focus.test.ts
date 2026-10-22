import assert from "node:assert/strict";
import { test } from "node:test";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { history, undoDepth } from "@codemirror/commands";
import { livePreview } from "../src/ui/components/livePreview.js";

const doc =
  "Before\n\n| Name | Value |\n| --- | --- |\n| Alpha | Beta |\n| Gamma | Delta |\n\nAfter";
const tables = (state: EditorState) =>
  state
    .facet(EditorView.decorations)
    .reduce((n, d) => n + (typeof d === "function" ? 0 : d.size), 0);

test("refreshing relationship previews keeps a focused table in source with draft, selection and undo", () => {
  const mode = new Compartment();
  let state = EditorState.create({
    doc,
    selection: { anchor: doc.indexOf("Alpha") },
    extensions: [markdown({ base: markdownLanguage }), history(), mode.of(livePreview(() => null))],
  });
  // The new compartment must inherit the actual EditorView focus, including on first activation.
  state = state.update({
    effects: mode.reconfigure(livePreview(() => "goal", undefined, true)),
  }).state;
  assert.equal(tables(state), 0);
  state = state.update({
    changes: { from: state.selection.main.head, insert: "Z" },
    selection: { anchor: state.selection.main.head + 1 },
  }).state;
  const text = state.doc.toString(),
    selection = state.selection,
    depth = undoDepth(state);
  for (const kind of ["card", "role"] as const) {
    state = state.update({
      effects: mode.reconfigure(livePreview(() => kind, undefined, true)),
    }).state;
    assert.equal(tables(state), 0);
    assert.equal(state.doc.toString(), text);
    assert.ok(state.selection.eq(selection));
    assert.equal(undoDepth(state), depth);
  }
  state = state.update({ changes: { from: state.selection.main.head, insert: "Q" } }).state;
  assert.match(state.doc.toString(), /ZQAlpha/);
});

test("unfocused tables remain widgets after relationship refresh; a focused outside cursor does too", () => {
  const mode = new Compartment();
  let state = EditorState.create({
    doc,
    selection: { anchor: doc.indexOf("Alpha") },
    extensions: [markdown({ base: markdownLanguage }), mode.of(livePreview(() => null))],
  });
  assert.equal(tables(state), 1);
  state = state.update({
    effects: mode.reconfigure(livePreview(() => "card", undefined, false)),
  }).state;
  assert.equal(tables(state), 1);
  state = state.update({
    selection: { anchor: 0 },
    effects: mode.reconfigure(livePreview(() => "role", undefined, true)),
  }).state;
  assert.equal(tables(state), 1);
});
