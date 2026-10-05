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

## Paths in documents

Addresses in `resource`, `sources` and links resolve from the document that
declares them: `./` and `../` are relative to it, a single leading `/` starts
at `.tent/`, and `file:` or other URIs are absolute. Relative paths can reach
Workspace files outside `.tent/`; anything outside the Workspace needs a
`file:` URI. Other text stays a plain description.
