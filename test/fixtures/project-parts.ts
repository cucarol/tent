/** Small real project inputs shared by scan tests and the before/after trial. */
export function novelProjectFiles(): Record<string, string | Uint8Array> {
  return {
    "README.md": "# Novel\nThirty chapters and working notes.\n",
    "notes/characters.md": "# Characters\nTwo protagonists.\n",
    "notes/plot.md": "# Plot\nA return journey.\n",
    ...Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [
        `chapters/chapter-${String(i + 1).padStart(2, "0")}.md`,
        `# Chapter ${i + 1}\nThe story continues.\n`,
      ]),
    ),
  };
}

export function videoProjectFiles(): Record<string, string | Uint8Array> {
  return {
    "README.md": "# Video\nEpisode production.\n",
    "scripts/episode-one.md": "# Episode one\nOpening scene.\n",
    "scripts/episode-two.md": "# Episode two\nClosing scene.\n",
    "assets/footage/take.mp4": new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112]),
    "assets/audio/theme.wav": new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0]),
    "assets/images/still.png": new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    "assets/fonts/title.woff2": new Uint8Array([119, 79, 70, 50, 0, 0, 0, 0]),
    "assets/footage/camera-dump": new Uint8Array([67, 65, 77, 0, 1, 2, 3]),
  };
}
