import { useEffect, useMemo, useRef } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { workspaceImage } from "../data/api.js";
import type { Graph } from "../data/store.js";
import { primaryOf, refKey } from "../data/store.js";
import { loadableImage, resolveHref, workspaceImagePath } from "../util.js";
import { t } from "../i18n.js";
import { glyphSvg } from "./Glyph.js";
import type { SnapshotRef } from "../data/types.js";

/** An image that cannot be shown, as a marker naming its file. */
function fileChip(path: string, alt: string) {
  const file = document.createElement("span");
  file.className = "doc-file";
  file.title = t.doc.workspaceFile(path);
  file.textContent = t.doc.image(alt || path.split("/").pop()!);
  return file;
}

/** Renders a Tent document; links to Tent documents become in-app references. */
export function Markdown({
  body,
  fromPath,
  graph,
  onOpen,
}: {
  body: string;
  fromPath: string;
  graph: Graph;
  onOpen: (ref: SnapshotRef) => void;
}) {
  const html = useMemo(() => {
    const box = document.createElement("div");
    box.innerHTML = DOMPurify.sanitize(marked.parse(body, { gfm: true, async: false }) as string);
    box.querySelectorAll("a[href]").forEach((anchor) => {
      const target = resolveHref(fromPath, anchor.getAttribute("href") ?? "");
      const ref = target.tentPath ? graph.snapshot.paths[target.tentPath] : undefined;
      if (ref && graph.exists(ref)) {
        const glyph = glyphSvg(
          ref.kind === "node" ? primaryOf(graph.nodes.get(ref.id)!.type) : ref.kind,
        );
        const link = document.createElement("a");
        link.className = "doc-ref";
        link.href = `#${ref.id}`;
        link.dataset.ref = refKey(ref);
        link.innerHTML = `${glyph}<span></span>`;
        link.querySelector("span")!.textContent = anchor.textContent;
        anchor.replaceWith(link);
      } else if (target.external) {
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
      const workspace = workspaceImagePath(fromPath, src);
      if (workspace) {
        img.removeAttribute("src");
        img.dataset.workspace = workspace;
        return;
      }
      const target = resolveHref(fromPath, src);
      img.replaceWith(fileChip(target.file ?? target.tentPath ?? src, img.alt));
    });
    return box.innerHTML;
  }, [body, fromPath, graph]);

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
        const link = (event.target as HTMLElement).closest<HTMLElement>("[data-ref]");
        if (!link) return;
        event.preventDefault();
        const [kind, id] = link.dataset.ref!.split(":");
        onOpen({ kind: kind as SnapshotRef["kind"], id: id! });
      }}
    />
  );
}
