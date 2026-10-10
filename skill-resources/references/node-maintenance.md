# Save Nodes

| When | Command | Read |
| --- | --- | --- |
| Change materials or fields | `tent node write <id> --input-json -` with `{"baseEtag":"<etag>","frontmatter":{"sources":[{"resource":"docs/a.md"}]}}` | `etag` |
| Several Nodes in one commit | `tent node write-many --input-json -` with `{"items":[{"op":"create","ref":"a","name":"<name>","type":"prompt","body":"..."},{"op":"update","nodeId":"<id>","baseEtag":"<etag>","body":"..."}]}` | `results[].nodeId` |
| A Node is behind or ahead | `tent node check <id>` | `state`, `reasons` |
| A behind Node needs a fix | `tent node write <id> --confirm --base-etag <etag> --body -` | `etag` |
| Rename or move | `tent node rename <id> <name>`, `tent node move <id> --parent <id>` | the id stays |
| Retire a subtree | `tent node archive <id>`; undo with `tent node restore <id> --archive-commit <commit>` | `commit` |

Behind: a Node's material or ancestor goal changed since it was saved or confirmed, or `stale_after` passed. Ahead: a goal has no undeprecated output under it, or changed since its outputs were reviewed.

- On an ETag conflict, reread, merge and save with the new `etag`. A partial read's `read:` ETag cannot replace or confirm a body.
- `append --heading <title>` adds to the end of an existing section with that heading, or starts one.
- Invalid frontmatter stays as written and leads the brief. Declare materials with the CLI.
- `--resource` is the main material, `sources` the rest. Pass Workspace-root paths (`docs/x.md`); Tent stores them Node-relative. Point at a section (`docs/x.md#State`) so other edits keep it current, or a directory (`src/auth/`) for every file in it. A `goal` or `prompt` takes its grounds as material, not code.
- `link-output` needs the file present in the Workspace checkout; merge a worktree branch first.
