# Runtime access

Run the CLI bundled with this Skill package:

```text
node "<installed Skill directory>/../../skill-resources/scripts/tent.mjs" <command> <arguments>
```

Every `tent ...` example is shorthand for this command. It needs Node.js 22.19+
and Git. If the bundled script is missing, report a broken installation rather
than using another Tent from PATH.

- **Workspace**: the folder containing `.tent/`. Its `.tent/` is the graph.
  Pass `--workspace <root>` when your shell runs elsewhere.
- **Direct access**: Node, Role and Card commands call Core directly, with no
  background service, Session registration or credentials.
- **Arguments**: `tent node --help`, `tent role --help` and `tent card --help`
  list them exactly.
- **Input**: pass Markdown and JSON through stdin (`-`) to keep newlines and
  structure intact.
- **Build identity**: `tent version --json` shows the version, source commit,
  build-session start time, dirty state and actual runtime path. Use it to
  compare installed copies; it does not check for updates over the network.

## Paths in documents

Addresses in `resource`, `sources` and links resolve from the Markdown document
that declares them:

- `./` and `../` are relative to that document.
- A single leading `/` starts at `.tent/`.
- `file:` and other URIs are absolute.
- Any other text stays a plain description; Tent never guesses it into a path.

Relative paths can reach Workspace files outside `.tent/`. Anything outside
the Workspace needs a `file:` URI. The Workspace, not your shell's cwd, sets
where paths resolve.

## Hooks

The plugin provides SessionStart and Stop Hooks; installing it does not turn
Tent on in every project. Hook trust and reload belong to the host, and a
configured Hook does not show that its event ran. Every command above works
without Hooks.
SessionStart includes the build identity and reports a commit mismatch when
the Workspace is a Tent source checkout. A mismatch does not say which copy
is newer; use the intended source to rebuild or reinstall.
