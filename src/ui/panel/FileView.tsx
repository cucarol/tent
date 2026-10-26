import { useEffect, useState, type ReactNode } from "react";
import { ApiError, nodeText, workspaceBlob, type FileInfo, type NodeText } from "../data/api.js";
import {
  fileLimit,
  fileOf,
  filesOf,
  fileSize,
  infoOf,
  useFiles,
  type NodeFile,
} from "../data/files.js";
import type { SnapshotNode } from "../data/types.js";
import { FileGlyph, Icon } from "../components/Glyph.js";
import { t } from "../i18n.js";

export type LocalFile = Extract<NodeFile, { kind: "file" }>;

const limitOf = (file: LocalFile) => fileLimit(file.show);

/**
 * The files a Node names, above its text. Its own file opens with the page; with sources, a row of them
 * lets one be opened in its place. Each is shown by its suffix: HTML in a sandboxed frame, images, PDF in
 * the browser's own viewer, audio and video in place, text and code as written, other files as a file
 * card. A remote address is shown and linked, never fetched.
 */
export function FileView({
  node,
  onToast,
}: {
  node: SnapshotNode;
  onToast: (text: string) => void;
}) {
  const own = fileOf(node);
  const list = filesOf(node);
  const files = useFiles();
  const [picked, setPicked] = useState<{ node: string; path: string | null } | null>(null);
  const shown = picked?.node === node.id ? picked.path : own?.kind === "file" ? own.path : null;
  const file = list.find((f) => f.file.path === shown)?.file;
  return (
    <>
      {own?.kind === "uri" && <RemoteFile uri={own.uri} />}
      {list.some((f) => f.source) && (
        <div className="file-tabs" role="group" aria-label={t.file.label}>
          {list.map(({ file: f, source }) => (
            <button
              key={f.path}
              type="button"
              className={`file-tab${f.path === shown ? " is-on" : ""}`}
              aria-pressed={f.path === shown}
              data-tip={f.path}
              onClick={() => setPicked({ node: node.id, path: f.path === shown ? null : f.path })}
            >
              <FileGlyph show={f.show} size={13} />
              <span className="file-tab-name">{f.name}</span>
              <small>{source ? t.rel.sourceN(source) : t.rel.mainMaterial}</small>
            </button>
          ))}
        </div>
      )}
      {file && (
        <OneFile
          key={file.path}
          nodeId={node.id}
          file={file}
          // Sizes are read ahead only for Nodes' own files; a source's comes with its text.
          info={
            own?.kind === "file" && own.path === file.path ? infoOf(files, file.path) : undefined
          }
          onToast={onToast}
        />
      )}
    </>
  );
}

function OneFile({
  nodeId,
  file,
  info,
  onToast,
}: {
  nodeId: string;
  file: LocalFile;
  info: FileInfo | null | undefined;
  onToast: (text: string) => void;
}) {
  if (info === null) return <MissingFile file={file} onToast={onToast} />;
  if (file.show === "text")
    return <TextFile nodeId={nodeId} file={file} info={info} onToast={onToast} />;
  if (file.show === "other" || (info && info.size > limitOf(file)))
    return <FileCard file={file} info={info} onToast={onToast} />;
  return <Preview file={file} info={info} onToast={onToast} />;
}

/** Text and code as written, read through the Node so only the files it names are read. */
function TextFile({
  nodeId,
  file,
  info,
  onToast,
}: {
  nodeId: string;
  file: LocalFile;
  info: FileInfo | undefined;
  onToast: (text: string) => void;
}) {
  const [read, setRead] = useState<NodeText | "missing" | "binary" | "failed" | undefined>();
  useEffect(() => {
    const abort = new AbortController();
    setRead(undefined);
    nodeText(nodeId, file.path, abort.signal).then(setRead, (error: unknown) => {
      if (abort.signal.aborted) return;
      const status = error instanceof ApiError ? error.status : 0;
      setRead(status === 404 ? "missing" : status === 415 ? "binary" : "failed");
    });
    return () => abort.abort();
  }, [nodeId, file.path, info?.modifiedAt]);
  if (read === "missing") return <MissingFile file={file} onToast={onToast} />;
  // Not yet known to be there: no frame that a missing file would take back a moment later.
  if (read === undefined && info === undefined) return null;
  if (read === "binary")
    return <FileCard file={{ ...file, show: "other" }} info={info} onToast={onToast} />;
  const name = t.file.preview(file.name);
  return (
    <section className="file-view is-text" aria-label={name}>
      <FileBar
        file={file}
        info={typeof read === "object" ? { size: read.size, modifiedAt: read.modifiedAt } : info}
        onToast={onToast}
      />
      {typeof read === "object" ? (
        <pre className="file-text" tabIndex={0}>
          {read.text}
        </pre>
      ) : (
        <div className="file-stage">
          <p className="file-note">{read === "failed" ? t.file.failed : t.file.loading}</p>
        </div>
      )}
      {typeof read === "object" && read.truncated && (
        <p className="file-hint">{t.file.truncated(fileSize(new Blob([read.text]).size))}</p>
      )}
    </section>
  );
}

/**
 * Fetches a file with the page's token into a blob URL, released when the view goes away. A PDF is
 * retyped, so whatever the file holds the browser only ever opens it in its PDF viewer.
 */
export function useBlobUrl(path: string, stamp: string | undefined, pdf = false) {
  const [state, setState] = useState<{ url?: string; failed?: boolean }>({});
  useEffect(() => {
    const abort = new AbortController();
    let url: string | undefined;
    setState({});
    workspaceBlob(path, abort.signal).then(
      (blob) => {
        url = URL.createObjectURL(pdf ? new Blob([blob], { type: "application/pdf" }) : blob);
        setState({ url });
      },
      () => !abort.signal.aborted && setState({ failed: true }),
    );
    return () => {
      abort.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, stamp, pdf]);
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
  const { url, failed } = useBlobUrl(file.path, info?.modifiedAt, file.show === "pdf");
  const name = t.file.preview(file.name);
  const body = failed ? (
    <p className="file-note">{t.file.failed}</p>
  ) : !url ? (
    <p className="file-note">{t.file.loading}</p>
  ) : file.show === "html" ? (
    // No allow-scripts or allow-same-origin: the page cannot run code or reach this one.
    <iframe className="file-frame" sandbox="" src={url} title={name} />
  ) : file.show === "pdf" ? (
    // The browser's PDF viewer refuses a sandboxed frame; the blob is typed as PDF instead.
    <iframe className="file-frame" src={url} title={name} />
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

/** A file that is not where the Node says: one line in amber and its path to copy, no frame. */
function MissingFile({ file, onToast }: { file: LocalFile; onToast: (text: string) => void }) {
  return (
    <p className="file-gone" aria-label={t.file.label} title={file.path}>
      <FileGlyph show={file.show} missing size={14} />
      <span>{t.file.moved(file.name)}</span>
      <CopyPath path={file.path} onToast={onToast} />
    </p>
  );
}

/** A file listed rather than shown: its name, size and path. */
function FileCard({
  file,
  info,
  onToast,
}: {
  file: LocalFile;
  info: FileInfo | undefined;
  onToast: (text: string) => void;
}) {
  return (
    <section className="file-card" aria-label={t.file.label}>
      <FileGlyph show={file.show} size={22} />
      <div className="file-card-main">
        <div className="file-card-name">
          {file.name}
          {file.ext && <span className="file-ext">{file.ext}</span>}
        </div>
        <div className="file-card-meta">
          {info && <span>{fileSize(info.size)}</span>}
          <span className="mono">{file.path}</span>
        </div>
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
