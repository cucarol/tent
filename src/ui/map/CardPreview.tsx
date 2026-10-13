// What a card shows under itself when its file preview is open, the way a Markdown note embeds a file:
// a look at it, not a viewer. Only audio takes the pointer, for its play button; elsewhere a click selects
// the card and the wheel still zooms the map. The Node's page beside the map holds the full view.
import { useEffect, useState } from "react";
import { workspaceBlob } from "../data/api.js";
import { infoOf, isMarkdown, useFiles, type FileKind } from "../data/files.js";
import type { Graph } from "../data/store.js";
import { useBlobUrl, type LocalFile } from "../panel/FileView.js";
import { Markdown } from "../components/Markdown.js";
import { Icon } from "../components/Glyph.js";
import { t } from "../i18n.js";

/** The height of the preview joined under a card's title row, by what it shows; the card keeps its width. */
export const PREVIEW = {
  h: { html: 168, image: 160, pdf: 200, video: 148, audio: 52, text: 150 } satisfies Record<
    Exclude<FileKind, "other">,
    number
  >,
  markdown: 176,
};
export const previewHeight = (file: LocalFile) =>
  file.show === "other"
    ? 0
    : file.show === "text" && isMarkdown(file)
      ? PREVIEW.markdown
      : PREVIEW.h[file.show];

/** Text is read up to this many bytes and lines: a card shows the head of a file. */
const TEXT = { bytes: 16 * 1024, lines: 40 };

export function CardPreview({ file, graph }: { file: LocalFile; graph: Graph }) {
  const info = infoOf(useFiles(), file.path) ?? undefined;
  const markdown = file.show === "text" && isMarkdown(file);
  return (
    <div
      className={`mpreview is-${markdown ? "markdown" : file.show}`}
      style={{ height: previewHeight(file) }}
      aria-label={t.file.preview(file.name)}
    >
      {file.show === "text" ? (
        <TextPeek file={file} stamp={info?.modifiedAt} graph={markdown ? graph : null} />
      ) : (
        <BlobPeek file={file} stamp={info?.modifiedAt} />
      )}
    </div>
  );
}

function BlobPeek({ file, stamp }: { file: LocalFile; stamp: string | undefined }) {
  const { url, failed } = useBlobUrl(file.path, stamp, file.show === "pdf");
  if (failed) return <p className="mpreview-note">{t.file.failed}</p>;
  if (!url) return <p className="mpreview-note">{t.file.loading}</p>;
  if (file.show === "html")
    return (
      // No allow-scripts or allow-same-origin: the page cannot run code or reach this one. Drawn at twice
      // the size and scaled down, so it reads as the page and not as its narrow layout.
      <iframe className="mpreview-page" sandbox="" src={url} tabIndex={-1} title={file.name} />
    );
  if (file.show === "pdf")
    return (
      <iframe
        className="mpreview-pdf"
        src={`${url}#toolbar=0&navpanes=0&view=FitH`}
        tabIndex={-1}
        title={file.name}
      />
    );
  if (file.show === "video")
    return (
      <>
        <video className="mpreview-media" src={url} muted preload="metadata" />
        <span className="mpreview-play">
          <Icon name="play" size={16} />
        </span>
      </>
    );
  if (file.show === "audio")
    return <audio className="mpreview-audio nopan nodrag" src={url} controls preload="metadata" />;
  return <img className="mpreview-media" src={url} alt="" draggable={false} />;
}

/** The head of a text file; Markdown is rendered as the page reads it, anything else shown as written. */
function TextPeek({
  file,
  stamp,
  graph,
}: {
  file: LocalFile;
  stamp: string | undefined;
  graph: Graph | null;
}) {
  const [text, setText] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const abort = new AbortController();
    setText(undefined);
    workspaceBlob(file.path, abort.signal)
      .then((blob) => blob.slice(0, TEXT.bytes).text())
      .then(
        (s) => setText(s.split(/\r?\n/).slice(0, TEXT.lines).join("\n")),
        () => !abort.signal.aborted && setText(null),
      );
    return () => abort.abort();
  }, [file.path, stamp]);
  if (text === null) return <p className="mpreview-note">{t.file.failed}</p>;
  if (text === undefined) return <p className="mpreview-note">{t.file.loading}</p>;
  if (graph)
    return (
      <div className="mpreview-md">
        <Markdown body={text} fromPath="" graph={graph} onOpen={() => {}} />
      </div>
    );
  return <pre className="mpreview-text">{text}</pre>;
}
