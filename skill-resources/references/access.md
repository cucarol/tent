# Runtime access

Run the CLI bundled with this Skill package:

```text
node "<installed Skill directory>/../../skill-resources/scripts/tent.mjs" <command> <arguments>
```

Every `tent ...` example is shorthand for this command. It needs Node.js 22.19+
and Git. If the bundled script is missing, report a broken installation rather
than using another Tent from PATH.

- **Workspace**: the folder containing `.tent/`. Pass `--workspace <root>` when
  your shell runs elsewhere; without it, Tent uses the nearest `.tent/` above
  the current folder.
- **Arguments**: `tent node --help`, `tent role --help` and `tent card --help`
  list them exactly.
- **Input**: pass Markdown and JSON through stdin (`-`).
- **Build identity**: `tent version --json` shows the version, source commit
  and runtime path of this copy.
- **Hooks** are optional; every command works without them. See the
  tent-init host integration notes.

## Paths

- **CLI arguments** that name material (`--resource`, `--sources-json`,
  `--source` and write JSON frontmatter) resolve from the Workspace root:
  `docs/x.md`, `./docs/x.md` and `/docs/x.md` are the same file, and
  `.tent/Area/Topic/Topic.md` is a Node file. A Node id also works.
- **Stored documents** hold addresses that resolve from the document that
  declares them; Tent rewrites CLI paths into this form when saving. `./` and
  `../` are relative to the document, a single leading `/` starts at
  `.tent/`, and `file:` or other URIs are absolute. Write this form yourself
  only in raw Markdown edits and body links. Relative paths can reach
  Workspace files outside `.tent/`; anything outside the Workspace needs a
  `file:` URI. Other text stays a plain description.
