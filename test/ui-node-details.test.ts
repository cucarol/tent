import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { sectionObservation, type NodeSection } from "../src/ui/data/node-details.js";
import { buildGraph } from "../src/ui/data/store.js";
import { documentRef } from "../src/ui/data/document-links.js";
import { fileOf } from "../src/ui/data/files.js";
import type {
  NodeCardSummary,
  NodeHistoryDetails,
  NodeRelationsDetails,
  Snapshot,
  SnapshotNode,
} from "../src/ui/data/types.js";
import { History, NodeProps, ReadState } from "../src/ui/panel/Details.js";
import { headerMaterials, NodeCardLine } from "../src/ui/panel/Reader.js";
import { resolveDocumentRelations } from "../src/core/graph/workspace-relations.js";
import type { FsAdapter } from "../src/core/store/adapter.js";
import { NodeMenu } from "../src/ui/panel/Manage.js";
import { setLang, t } from "../src/ui/i18n.js";

setLang("en", false);
const node: SnapshotNode = {
  id: "node-selected",
  name: "Selected",
  path: "Now",
  notePath: "Now/Now.md",
  depth: 0,
  type: "goal",
  tags: [],
  status: "stable",
  archived: false,
  description: "",
  body: "",
  parentId: null,
  childIds: [],
  links: [],
  materials: [],
  incoming: [],
  history: [],
};
const snapshot: Snapshot = {
  workspace: { id: "ws-details", name: "Details", revision: "map-only", generatedAt: "" },
  nodes: [node],
  roles: [],
  cards: [],
  commits: [],
  paths: {},
};
const graph = buildGraph(snapshot, null, false);
const section = <T>(data: T | null = null, error: unknown = null): NodeSection<T> => ({
  data,
  error,
  retry() {},
});
const relations: NodeRelationsDetails = {
  nodeId: node.id,
  links: [],
  materials: [],
  incoming: [],
  roles: [],
  refs: [],
};
const noop = () => {};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("map-only document links open only checked outgoing Role and published Card targets", () => {
  const checked: NodeRelationsDetails = {
    ...relations,
    links: [
      { label: "Role", href: "/roles/role-reader.md", ref: { kind: "role", id: "role-reader" } },
      { label: "Card", href: "/cards/card-ready.md", ref: { kind: "card", id: "card-ready" } },
      { label: "Draft", href: "/cards/card-draft.md", ref: { kind: "card", id: "card-draft" } },
      { label: "Gone", href: "/roles/role-gone.md", ref: { kind: "role", id: "role-gone" } },
    ],
    refs: [
      { kind: "role", id: "role-reader", title: "Reader", exists: true },
      { kind: "card", id: "card-ready", title: "Ready", exists: true },
      { kind: "card", id: "card-draft", title: "Draft", exists: false },
      { kind: "role", id: "role-gone", title: "Gone", exists: false },
    ],
  };
  assert.deepEqual(documentRef(graph, node.notePath, "../roles/role-reader.md#section", checked), {
    kind: "role",
    id: "role-reader",
  });
  assert.deepEqual(documentRef(graph, node.notePath, "/cards/card-ready.md", checked), {
    kind: "card",
    id: "card-ready",
  });
  for (const href of [
    "/cards/card-draft.md",
    "/roles/role-gone.md",
    "/roles/role-unknown.md",
    "https://example.test/roles/role-reader.md",
  ])
    assert.equal(documentRef(graph, node.notePath, href, checked), null);
  assert.equal(documentRef(graph, node.notePath, "/cards/card-ready.md"), null);
  assert.equal(
    documentRef(buildGraph(snapshot), node.notePath, "/cards/card-ready.md", checked),
    null,
  );
  const mapped = buildGraph(
    { ...snapshot, paths: { [node.notePath]: { kind: "node", id: node.id } } },
    null,
    false,
  );
  assert.deepEqual(documentRef(mapped, node.notePath, "/Now/Now.md", checked), {
    kind: "node",
    id: node.id,
  });
});

test("a new Node or live revision replaces pending section successes and failures independently", async () => {
  const oldNode = deferred<string>();
  const oldRevision = deferred<string>();
  const current = deferred<string>();
  const cards = deferred<string>();
  const accepted: string[] = [];
  const failed: unknown[] = [];
  const stopNode = sectionObservation(
    () => oldNode.promise,
    (v) => accepted.push(v),
    (e) => failed.push(e),
  );
  stopNode();
  const stopRevision = sectionObservation(
    () => oldRevision.promise,
    (v) => accepted.push(v),
    (e) => failed.push(e),
  );
  stopRevision();
  const stopCurrent = sectionObservation(
    () => current.promise,
    (v) => accepted.push(v),
    (e) => failed.push(e),
  );
  sectionObservation(
    () => cards.promise,
    (v) => accepted.push(v),
    (e) => failed.push(e),
  );
  oldNode.resolve("wrong Node");
  oldRevision.reject(new Error("old revision"));
  current.resolve("current history");
  await tick();
  assert.deepEqual(accepted, ["current history"]);
  assert.deepEqual(failed, []);
  stopCurrent();
  cards.reject(new Error("Card read failed"));
  await tick();
  assert.equal((failed[0] as Error).message, "Card read failed");
});

test("a section distinguishes unread, failed with retry, and a successful empty answer", () => {
  const render = (value: NodeSection<unknown>) =>
    renderToStaticMarkup(createElement(ReadState, { section: value }));
  assert.match(render(section()), new RegExp(t.page.reading));
  const failed = render(section(null, new Error("Read refused")));
  assert.match(failed, /role="alert"/);
  assert.match(failed, /Read refused/);
  assert.match(failed, new RegExp(t.app.retry));
  assert.equal(render(section([])), "");
});

test("history rows render old-path move versions without a workspace commit graph", () => {
  const html = renderToStaticMarkup(
    createElement(History, {
      id: node.id,
      path: node.notePath,
      items: [
        {
          hash: "abcdef123456",
          date: "2026-10-22T00:00:00Z",
          file: {
            path: "Now/Now.md",
            status: "M",
            ref: { kind: "node", id: node.id },
            before: { commit: "111111", path: "Before/Before.md" },
            after: { commit: "abcdef123456", path: "Now/Now.md" },
          },
        },
      ],
    }),
  );
  assert.match(html, /abcdef1/);
  assert.match(html, /versions/);
  assert.doesNotMatch(html, new RegExp(t.history.none));
});

test("Node properties defer incoming and use named relations while the graph stays map-only", () => {
  const details = {
    history: section({ nodeId: node.id, items: [] }),
    outgoing: section(relations),
    incoming: section<NodeRelationsDetails>(),
    incomingOpen: false,
    onIncoming: noop,
  };
  const collapsed = renderToStaticMarkup(
    createElement(NodeProps, { graph, node, onOpen: noop, details }),
  );
  assert.match(collapsed, new RegExp(t.rel.loadIncoming));
  assert.doesNotMatch(collapsed, new RegExp(t.rel.noIncoming));
  const outgoing: NodeRelationsDetails = {
    ...relations,
    roles: [{ id: "role-lane", title: "Actual lane", status: "stable" }],
    links: [
      { href: "cards/card-related.md", label: "Card", ref: { kind: "card", id: "card-related" } },
    ],
    refs: [{ kind: "card", id: "card-related", title: "Named Card", exists: true }],
    materials: [
      { kind: "invalid", resource: "./bad%GG", field: "sources", index: 0, error: "Bad locator" },
    ],
  };
  const incoming: NodeRelationsDetails = {
    ...relations,
    incoming: [
      {
        from: { kind: "card", id: "card-pending" },
        via: "card-source",
        title: "Pinned input",
        cardState: "pending",
        changedSince: true,
        version: { commit: "abcdef123456", path: "Before/Before.md" },
      },
    ],
  };
  const loaded = renderToStaticMarkup(
    createElement(NodeProps, {
      graph,
      node,
      onOpen: noop,
      details: {
        ...details,
        outgoing: section(outgoing),
        incoming: section(incoming),
        incomingOpen: true,
      },
    }),
  );
  for (const text of [
    "Actual lane",
    "Named Card",
    "Pinned input",
    "Bad locator",
    t.rel.changedSince,
  ])
    assert.ok(loaded.includes(text), text);
  assert.equal(graph.detailed, false);
  assert.equal(graph.cards.size, 0);
  assert.equal(graph.roles.size, 0);
});

test("Card summaries render server titles, states and lanes without Work or the full graph", () => {
  const card: NodeCardSummary = {
    id: "card-related",
    title: "Explicit card name",
    state: "consumed",
    returnTo: "role-owner",
    status: "stable",
    target: "role-lane",
    receivedBy: "role-lane",
    publishedAt: "2026-10-22T00:00:00Z",
    sources: [],
    lane: { id: "role-lane", title: "Actual lane" },
  };
  const html = renderToStaticMarkup(createElement(NodeCardLine, { card, onOpen: noop }));
  assert.match(html, /Explicit card name/);
  assert.match(html, /Actual lane/);
  assert.ok(html.includes(t.cardState.doing));
  const gone = renderToStaticMarkup(
    createElement(NodeCardLine, {
      card: { ...card, lane: { id: "role-gone", title: null } },
      onOpen: noop,
    }),
  );
  assert.ok(gone.includes(t.work.goneRole("role-gone")));
});

test("named outgoing and incoming details keep the property list cap", () => {
  const refs = Array.from({ length: 10 }, (_, i) => ({
    kind: "card" as const,
    id: `card-${i}`,
    title: `Outgoing ${i}`,
    exists: true,
  }));
  const outgoing = {
    ...relations,
    refs,
    links: refs.map((ref) => ({ label: ref.title, href: `/cards/${ref.id}.md`, ref })),
  };
  const incoming = {
    ...relations,
    refs,
    incoming: refs.map((from, i) => ({
      from,
      title: `Incoming ${i}`,
      via: "card-source" as const,
    })),
  };
  const html = renderToStaticMarkup(
    createElement(NodeProps, {
      graph,
      node,
      onOpen: noop,
      details: {
        history: section({ nodeId: node.id, items: [] }),
        outgoing: section(outgoing),
        incoming: section(incoming),
        incomingOpen: true,
        onIncoming: noop,
      },
    }),
  );
  for (const name of ["Outgoing 0", "Outgoing 7", "Incoming 0", "Incoming 7"])
    assert.ok(html.includes(name), name);
  for (const name of ["Outgoing 8", "Outgoing 9", "Incoming 8", "Incoming 9"])
    assert.ok(!html.includes(name), name);
  assert.equal((html.match(/class="prop-more"/g) ?? []).length, 2);
  assert.match(html, /is-wide/);
});

test("a Node still offers management before the complete impact graph is loaded", () => {
  const html = renderToStaticMarkup(
    createElement(NodeMenu, { graph, node, onGone: noop, onToast: noop }),
  );
  assert.ok(html.includes(t.manage.more));
  assert.doesNotMatch(html, /ask-list/);
});

test("provisional header materials agree with Core and preserve source spelling and positions", async () => {
  for (const notePath of ["Root/Root.md", "Root/Child/Child.md"]) {
    const front = {
      resource: notePath === "Root/Root.md" ? "../../out/main.md" : "../../../out/main.md",
      sources: [
        { resource: "node-other" },
        { resource: "role-owner" },
        { resource: "card-related" },
        { resource: "out/source.md" },
        {
          resource:
            "   " + (notePath === "Root/Root.md" ? "../../" : "../../../") + "out/a%20b.md  ",
        },
        { resource: "https://EXAMPLE.test/a/../b" },
        { resource: "https://example.test/a b" },
      ],
    };
    const preview = headerMaterials(notePath, front);
    assert.equal(preview.pending, false);
    const checked = await resolveDocumentRelations(
      {} as FsAdapter,
      [{ ref: { kind: "node", id: node.id }, path: notePath, data: front, body: "", etag: "" }],
      [],
      [],
    );
    for (const material of preview.materials) {
      const actual = checked.find((r) => r.via === material.field && r.index === material.index)!;
      assert.equal(material.resource, actual.raw);
      assert.equal(
        material.kind,
        actual.target.kind === "unresolved" ? "text" : actual.target.kind,
      );
      if (actual.target.kind === "file")
        assert.equal(material.workspacePath, actual.target.workspacePath);
      if (actual.target.kind === "uri") assert.equal(material.uri, actual.target.uri);
    }
    assert.equal(preview.materials.length, checked.length);
    assert.equal(preview.materials[5]!.workspacePath, "out/a b.md");
  }
});

test("Tent identities and uncertain declarations never create provisional file tabs or a materials row", () => {
  for (const resource of [
    "/Other/Other.md",
    "../Other/Other.md",
    "/roles/role-owner.md",
    "/cards/card-related.md",
    "node-other",
    "C:/outside/file.md",
    "C:\\outside\\file.md",
    "//host/file.md",
    "../../../outside.md",
    "../../..",
    "../../out/bad%GG.md",
    "../../out/file\\name.md",
    "../../out/*",
    "../../out/%2F",
    "../../out/?query",
    "../../out/?query/",
    "file:///C:/out/file.md",
    "https://example.test/\0bad",
  ]) {
    const preview = headerMaterials(node.notePath, { resource });
    assert.deepEqual(preview, { materials: [], pending: true }, resource);
    const html = renderToStaticMarkup(
      createElement(NodeProps, {
        graph,
        node,
        onOpen: noop,
        details: {
          history: section<NodeHistoryDetails>(),
          outgoing: section<NodeRelationsDetails>(),
          incoming: section<NodeRelationsDetails>(),
          incomingOpen: false,
          onIncoming: noop,
          materialsDeclared: preview.materials.length,
        },
      }),
    );
    assert.ok(
      html.includes(`<div class="prop is-wide" hidden=""><dt>${t.rel.materials}</dt>`),
      resource,
    );
  }
  assert.deepEqual(headerMaterials(node.notePath, { sources: ["../../out/file.md"] }), {
    materials: [],
    pending: true,
  });
});

test("a declared Workspace directory holds its materials row without becoming a file preview", () => {
  const front = { resource: "../../src/" };
  const preview = headerMaterials(node.notePath, front);
  assert.equal(preview.pending, false);
  assert.deepEqual(preview.materials, [
    {
      kind: "file",
      field: "resource",
      resource: "../../src/",
      workspacePath: "src",
      index: undefined,
    },
  ]);
  assert.equal(fileOf({ ...node, materials: preview.materials }), null);
  const html = renderToStaticMarkup(
    createElement(NodeProps, {
      graph,
      node,
      onOpen: noop,
      details: {
        history: section<NodeHistoryDetails>(),
        outgoing: section<NodeRelationsDetails>(),
        incoming: section<NodeRelationsDetails>(),
        incomingOpen: false,
        onIncoming: noop,
        materialsDeclared: preview.materials.length,
      },
    }),
  );
  assert.ok(html.includes(`<div class="prop is-wide"><dt>${t.rel.materials}</dt>`));
});
