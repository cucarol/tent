import { describe } from "../data/api.js";
import { t } from "../i18n.js";

export function CanvasNotice({ onNotice }: { onNotice: (message: string) => void }) {
  return (
    <div className="canvas-read-notice" role="status">
      <span title={t.map.canvasUnreadable}>{t.map.canvasUnreadable}</span>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(".tent/canvas.json").then(
            () => onNotice(t.file.copied),
            (error: unknown) => onNotice(describe(error)),
          );
        }}
      >
        {t.file.copyPath}
      </button>
    </div>
  );
}
