import { useEffect, useMemo, useRef } from "react";
import { isNodeId } from "../../core/base/id.js";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { workspaceImage } from "../data/api.js";
import type { Graph } from "../data/store.js";
import { primaryOf, refKey } from "../data/store.js";
import {
  directoryPath,
  loadableImage,
  markdownUriPattern,
  resolveHref,
  workspaceImagePath,
} from "../util.js";
import { t } from "../i18n.js";
import { glyphSvg } from "./Glyph.js";
import type { NodeRelationsDetails, SnapshotRef } from "../data/types.js";
import { documentRef } from "../data/document-links.js";

/** An image that cannot be shown, as a marker naming its file. */
function fileChip(path: string, alt: string) {
  const file = document.createElement("span");
  file.className = "doc-file";
  file.title = t.doc.workspaceFile(path);
  file.textContent = t.doc.image(alt || path.split("/").pop()!);
  return file;
}

/** A link to a Node or Card in the app, under its name. */
function refLink(ref: SnapshotRef, name: string, graph: Graph) {
  const glyph = glyphSvg(ref.kind === "node" ? primaryOf(graph.nodes.get(ref.id)!.type) : ref.kind);
  const link = document.createElement("a");
  link.className = "doc-ref";
  link.href = `#${ref.id}`;
  link.dataset.ref = refKey(ref);
  link.innerHTML = `${glyph}<span></span>`;
  link.querySelector("span")!.textContent = name;
  return link;
}

const MENTION = /\b(?:node|card)-[a-z0-9]+\b|\b[0-9a-f]{64}\b|\b[0-9a-f]{40}\b/gi;

/** A Node or Card id or a full commit hash written in the text, as it reads; null when the id is unknown. */
function mention(text: string, graph: Graph) {
  if ((text.length === 40 || text.length === 64) && !text.includes("-")) {
    const hash = document.createElement("button");
    hash.type = "button";
    hash.className = "doc-hash";
    hash.dataset.copy = text;
    hash.dataset.tip = text;
    hash.textContent = text.slice(0, 8);
    return hash;
  }
  const kind = isNodeId(text) ? "node" : "card";
  const name = kind === "node" ? graph.nodes.get(text)?.name : graph.cards.get(text)?.title;
  if (!name) return null;
  const link = refLink({ kind, id: text }, name, graph);
  link.dataset.tip = text;
  return link;
}

/** Ids and hashes in running text and in code spans that hold nothing else; links and blocks keep theirs. */
function mentions(box: HTMLElement, graph: Graph) {
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  for (const text of texts) {
    if (text.parentElement!.closest("a, pre")) continue;
    const code = text.parentElement!.tagName === "CODE" ? text.parentElement! : null;
    const parts: (string | Node)[] = [];
    let at = 0;
    for (const m of text.data.matchAll(MENTION)) {
      if (code && m[0] !== text.data.trim()) break;
      const shown = mention(m[0], graph);
      if (!shown) continue;
      parts.push(text.data.slice(at, m.index), shown);
      at = m.index + m[0].length;
    }
    if (!at) continue;
    if (code) code.replaceWith(parts[1]!);
    else text.replaceWith(...parts.concat(text.data.slice(at)).filter((p) => p !== ""));
  }
}

/** Renders a Tent document; links to Tent documents become in-app references. */
export function Markdown({
  body,
  fromPath,
  graph,
  relations,
  onOpen,
  onToast,
  historical = false,
  onDirectory,
}: {
  body: string;
  fromPath: string;
  graph: Graph;
  relations?: NodeRelationsDetails | null;
  onOpen: (ref: SnapshotRef) => void;
  onToast?: (text: string) => void;
  historical?: boolean;
  onDirectory?: (path: string) => void;
}) {
  const html = useMemo(() => {
    const box = document.createElement("div");
    box.innerHTML = DOMPurify.sanitize(marked.parse(body, { gfm: true, async: false }) as string, {
      // Preserve file: destinations long enough to route directories through the local service.
      ALLOWED_URI_REGEXP: markdownUriPattern,
    });
    box.querySelectorAll("a[href]").forEach((anchor) => {
      const target = resolveHref(fromPath, anchor.getAttribute("href") ?? "");
      const ref = documentRef(graph, fromPath, anchor.getAttribute("href") ?? "", relations);
      const directory = directoryPath(fromPath, anchor.getAttribute("href") ?? "");
      if (ref) {
        anchor.replaceWith(refLink(ref, anchor.textContent ?? "", graph));
      } else if (directory !== null && onDirectory) {
        anchor.className = "doc-file";
        anchor.setAttribute("href", "#");
        (anchor as HTMLElement).dataset.directory = directory;
      } else if (target.external && !/^file:/i.test(target.external)) {
        anchor.setAttribute("target", "_blank");
        anchor.setAttribute("rel", "noopener");
      } else {
        const file = document.createElement("span");
        file.className = "doc-file";
        file.title = t.doc.workspaceFile(target.file ?? target.tentPath ?? "");
        file.textContent = anchor.textContent;
        anchor.replaceWith(file);
      }
    });
    box.querySelectorAll("img").forEach((img) => {
      const src = img.getAttribute("src") ?? "";
      if (loadableImage(src)) return;
      // Workspace images load after rendering, through the service.
      const workspace = historical ? null : workspaceImagePath(fromPath, src);
      if (workspace) {
        img.removeAttribute("src");
        img.dataset.workspace = workspace;
        return;
      }
      const target = resolveHref(fromPath, src);
      img.replaceWith(fileChip(target.file ?? target.tentPath ?? src, img.alt));
    });
    mentions(box, graph);
    return box.innerHTML;
  }, [body, fromPath, graph, relations, historical, onDirectory]);

  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    box.current?.querySelectorAll<HTMLImageElement>("img[data-workspace]").forEach((img) => {
      const path = img.dataset.workspace!;
      workspaceImage(path).then(
        (url) => live && (img.src = url),
        () => live && img.replaceWith(fileChip(path, img.alt)),
      );
    });
    return () => {
      live = false;
    };
  }, [html]);

  return (
    <div
      ref={box}
      className="doc"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(event) => {
        const hash = (event.target as HTMLElement).closest<HTMLElement>("[data-copy]");
        if (hash) {
          const text = hash.dataset.copy!;
          navigator.clipboard?.writeText(text).then(
            () => onToast?.(t.sheet.copied(hash.textContent ?? text)),
            () => onToast?.(text),
          );
          return;
        }
        const directory = (event.target as HTMLElement).closest<HTMLElement>("[data-directory]");
        if (directory) {
          event.preventDefault();
          onDirectory?.(directory.dataset.directory!);
          return;
        }
        const link = (event.target as HTMLElement).closest<HTMLElement>("[data-ref]");
        if (!link) return;
        event.preventDefault();
        const [kind, id] = link.dataset.ref!.split(":");
        onOpen({ kind: kind as SnapshotRef["kind"], id: id! });
      }}
    />
  );
}
