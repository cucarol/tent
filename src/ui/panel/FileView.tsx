import { useEffect, useState, type ReactNode } from "react";
import { workspaceBlob, type FileInfo } from "../data/api.js";
import { fileOf, fileSize, infoOf, useFiles, type NodeFile } from "../data/files.js";
import type { SnapshotNode } from "../data/types.js";
import { FileGlyph, Icon } from "../components/Glyph.js";
import { t } from "../i18n.js";

type LocalFile = Extract<NodeFile, { kind: "file" }>;

/** Larger files are listed, not loaded into the page; the service holds the same limits. */
const MB = 1024 * 1024;
const limitOf = (file: LocalFile) =>
  file.show === "video" || file.show === "audio" ? 200 * MB : 20 * MB;

/**
 * A Node's own file, shown by its suffix above the Node's text: HTML in a sandboxed frame, images,
 * audio and video in place, other files as a file card. Markdown and code keep the page as it was.
 * A remote address is shown and linked, never fetched.
 */
export function FileView({
  node,
  onToast,
}: {
  node: SnapshotNode;
  onToast: (text: string) => void;
}) {
  const file = fileOf(node);
  const files = useFiles();
  if (!file) return null;
  if (file.kind === "uri") return <RemoteFile uri={file.uri} />;
  const info = infoOf(files, file.path);
  if (info === null) return <FileCard file={file} info={null} onToast={onToast} />;
  if (file.show === "text") return null;
  if (file.show === "other" || (info && info.size > limitOf(file)))
    return <FileCard file={file} info={info} onToast={onToast} />;
  return <Preview file={file} info={info} onToast={onToast} />;
}

/** Fetches a file with the page's token into a blob URL, released when the view goes away. */
function useBlobUrl(path: string, stamp: string | undefined) {
  const [state, setState] = useState<{ url?: string; failed?: boolean }>({});
  useEffect(() => {
    const abort = new AbortController();
    let url: string | undefined;
    setState({});
    workspaceBlob(path, abort.signal).then(
      (blob) => {
        url = URL.createObjectURL(blob);
        setState({ url });
      },
      () => !abort.signal.aborted && setState({ failed: true }),
    );
    return () => {
      abort.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, stamp]);
  return state;
}

function Preview({
  file,
  info,
  onToast,
}: {
  file: LocalFile;
  info: FileInfo | undefined;
  onToast: (text: string) => void;
}) {
  const { url, failed } = useBlobUrl(file.path, info?.modifiedAt);
  const name = t.file.preview(file.name);
  const body = failed ? (
    <p className="file-note">{t.file.failed}</p>
  ) : !url ? (
    <p className="file-note">{t.file.loading}</p>
  ) : file.show === "html" ? (
    // No allow-scripts or allow-same-origin: the page cannot run code or reach this one.
    <iframe className="file-frame" sandbox="" src={url} title={name} />
  ) : file.show === "image" ? (
    <img className="file-image" src={url} alt={name} />
  ) : file.show === "video" ? (
    <video className="file-media" src={url} controls preload="metadata" aria-label={name} />
  ) : (
    <audio className="file-media" src={url} controls preload="metadata" aria-label={name} />
  );
  return (
    <section className={`file-view is-${file.show}`} aria-label={name}>
      <FileBar file={file} info={info} onToast={onToast}>
        {file.show === "html" && url && (
          <button type="button" className="btn plain" onClick={() => openFramed(url, file.name)}>
            <Icon name="out" size={14} />
            {t.file.openTab}
          </button>
        )}
      </FileBar>
      <div className="file-stage">{body}</div>
      {file.show === "html" && url && <p className="file-hint">{t.file.sandboxed}</p>}
    </section>
  );
}

/**
 * Opens an HTML file in a new tab inside a sandboxed frame. The file itself would otherwise run as
 * this page's origin, next to its token.
 */
function openFramed(url: string, name: string) {
  const title = name.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const page = new Blob(
    [
      `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
        `<style>html,body,iframe{margin:0;border:0;width:100%;height:100%;display:block}</style>` +
        `<iframe sandbox src="${url}"></iframe>`,
    ],
    { type: "text/html" },
  );
  const wrapper = URL.createObjectURL(page);
  const link = Object.assign(document.createElement("a"), {
    href: wrapper,
    target: "_blank",
    rel: "noopener",
  });
  link.click();
  setTimeout(() => URL.revokeObjectURL(wrapper), 60_000);
}

function FileBar({
  file,
  info,
  onToast,
  children,
}: {
  file: LocalFile;
  info: FileInfo | undefined;
  onToast: (text: string) => void;
  children?: ReactNode;
}) {
  return (
    <div className="file-bar">
      <FileGlyph show={file.show} missing={info === null} size={15} />
      <span className="file-name">{file.name}</span>
      {info && <span className="file-size">{fileSize(info.size)}</span>}
      <span className="file-acts">
        {children}
        <CopyPath path={file.path} onToast={onToast} />
      </span>
    </div>
  );
}

function CopyPath({ path, onToast }: { path: string; onToast: (text: string) => void }) {
  return (
    <button
      type="button"
      className="btn plain"
      onClick={() =>
        navigator.clipboard?.writeText(path).then(
          () => onToast(t.file.copied),
          () => onToast(path),
        )
      }
      data-tip={path}
      data-tip-end=""
    >
      <Icon name="copy" size={14} />
      {t.file.copyPath}
    </button>
  );
}

/** A file listed rather than shown: its name, size and path, or that it is missing. */
function FileCard({
  file,
  info,
  onToast,
}: {
  file: LocalFile;
  info: FileInfo | undefined;
  onToast: (text: string) => void;
}) {
  const missing = info === null;
  return (
    <section className={`file-card${missing ? " is-missing" : ""}`} aria-label={t.file.label}>
      <FileGlyph show={file.show} missing={missing} size={22} />
      <div className="file-card-main">
        <div className="file-card-name">
          {file.name}
          {file.ext && <span className="file-ext">{file.ext}</span>}
          {missing && <span className="pill pill-drift">{t.file.missing}</span>}
        </div>
        <div className="file-card-meta">
          {info && <span>{fileSize(info.size)}</span>}
          <span className="mono">{file.path}</span>
        </div>
        {missing && <p className="file-note">{t.file.missingNote(file.path)}</p>}
        {info && info.size > limitOf(file) && file.show !== "other" && (
          <p className="file-note">{t.file.tooLarge}</p>
        )}
      </div>
      <CopyPath path={file.path} onToast={onToast} />
    </section>
  );
}

function RemoteFile({ uri }: { uri: string }) {
  const web = /^https?:\/\//i.test(uri);
  return (
    <section className="file-card is-remote" aria-label={t.file.remote}>
      <span className="file-glyph">
        <Icon name="globe" size={22} />
      </span>
      <div className="file-card-main">
        <div className="file-card-name">{t.file.remote}</div>
        <div className="file-card-meta">
          <span className="mono">{uri}</span>
        </div>
        <p className="file-note">{t.file.remoteNote}</p>
      </div>
      {web && (
        <a className="btn plain" href={uri} target="_blank" rel="noopener noreferrer">
          <Icon name="out" size={14} />
          {t.file.open}
        </a>
      )}
    </section>
  );
}
