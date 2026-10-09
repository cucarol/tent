/** The mark's three pieces: output on the right, prompt on the left, goal at the base (assets/icons/tent-mark.svg). */
const PIECES = [
  [
    "output",
    "M601 103L619 109L633 127L955 713L973 749L975 767L969 785L967 773L957 765L715 657L519 307L519 297L611 127L611 111Z",
  ],
  [
    "prompt",
    "M583 103L599 103L607 109L607 131L295 705L203 867L193 891L195 909L51 741L47 727L49 709L361 169L375 155L393 147Z",
  ],
  [
    "goal",
    "M707 661L733 667L959 769L967 777L967 787L961 795L949 801L249 931L217 929L209 925L197 909L197 883L287 723Z",
  ],
] as const;

/**
 * The only place the mark shows inside the page: while the workspace is read. The triangle opens round the point
 * as if pulled taut, each side a little thinner, turns once and settles back.
 */
export function Loader({ label }: { label: string }) {
  return (
    <div className="boot" role="status">
      {/* A margin round the mark leaves room for the opened triangle; the mark itself stays 56px. */}
      <svg
        className="loader"
        width="70"
        height="70"
        viewBox="-128 -128 1280 1280"
        aria-hidden="true"
      >
        <g className="loader-turn">
          {PIECES.map(([kind, d]) => (
            <path key={kind} className={`loader-piece is-${kind}`} d={d} />
          ))}
        </g>
        <circle className="loader-point" cx="524.8" cy="557.8" r="78.2" />
      </svg>
      <p>{label}</p>
    </div>
  );
}
