# Third-party notices

The Tent npm package ships the direct CLI and Skills. Its third-party runtime dependencies are installed separately by npm and include their own license files.

| Package | Version | License | Current use |
| --- | --- | --- | --- |
| `mdast-util-from-markdown` | See package-lock.json | MIT | Markdown parsing |
| `yaml` | See package-lock.json | ISC | YAML frontmatter |
| `zod` | See package-lock.json | MIT | Data validation |

The standalone Agent plugin bundles its runtime dependencies and generates their complete license notices during `npm run plugin:build`.

## Open Knowledge Format specification

`docs/upstream/okf-SPEC.md` is a copy of the Open Knowledge Format specification, `SPEC.md` in [GoogleCloudPlatform/open-knowledge-format](https://github.com/GoogleCloudPlatform/open-knowledge-format). Its text is unmodified; Tent adds only the leading comment that records the source, upstream commit and fetch date. The specification is licensed under the Apache License, Version 2.0, reproduced from upstream `LICENSE.md` in `docs/upstream/okf-LICENSE.md`. Upstream publishes no NOTICE file. Both files ship in the npm package because `scripts/okf-check.mjs` reads the pinned OKF version from the copy.
