import { useEffect, useRef, useState } from "react";
import { t } from "../i18n.js";

/** How long the empty state takes to fade once the first Nodes are in. */
const LEAVE_MS = 220;

/**
 * The middle of a map with no Nodes yet: what to say to an Agent to get one, with that sentence to copy.
 * It fades out over the map when the first Nodes arrive; the page never needs a refresh.
 */
export function FirstRun({ empty, onToast }: { empty: boolean; onToast: (text: string) => void }) {
  const [shown, setShown] = useState(empty);
  useEffect(() => {
    if (empty) return setShown(true);
    const timer = setTimeout(() => setShown(false), LEAVE_MS);
    return () => clearTimeout(timer);
  }, [empty]);
  const [what, setWhat] = useState(false);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!what) return;
    const away = (e: PointerEvent) => {
      if (!pop.current?.contains(e.target as Node)) setWhat(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setWhat(false);
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", key);
    };
  }, [what]);
  if (!shown) return null;

  const copy = () =>
    navigator.clipboard?.writeText(t.first.phrase).then(
      () => onToast(t.first.copied),
      () => onToast(t.first.phrase),
    );
  return (
    <div className={`first-run${empty ? "" : " is-leaving"}`}>
      <h2>{t.first.title}</h2>
      <p>{t.first.body}</p>
      <button type="button" className="btn" onClick={copy}>
        {t.first.copy}
      </button>
      <div className="first-run-what" ref={pop}>
        <button
          type="button"
          className="first-run-link"
          aria-expanded={what}
          onClick={() => setWhat(!what)}
        >
          {t.first.what}
        </button>
        {what && (
          <div className="first-run-pop" role="dialog" aria-label={t.first.what}>
            {t.first.terms.map(([term, meaning]) => (
              <p key={term}>
                <b>{term}</b>
                {t.first.sep}
                {meaning}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
