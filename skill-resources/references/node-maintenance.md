# Save Nodes

| When | Command | Read |
| --- | --- | --- |
| Change materials or fields | `tent node write <id> --input-json -` with `{"baseEtag":"<etag>","frontmatter":{"sources":[{"resource":"docs/a.md"}]}}` | `etag` |
| Several Nodes in one commit | `tent node write-many --input-json -` with `{"items":[{"op":"create","ref":"a","name":"<name>","type":"prompt","body":"..."},{"op":"update","nodeId":"<id>","baseEtag":"<etag>","body":"..."}]}` | `results[].nodeId` |
| A Node is behind or ahead | `tent node check <id>` | `state`, `reasons` |
| A behind Node needs a fix | `tent node write <id> --confirm --base-etag <etag> --body -` | `etag` |
| Rename or move | `tent node rename <id> <name>`, `tent node move <id> --parent <id>` | the id stays |
| Retire a subtree | `tent node archive <id>`; undo with `tent node restore <id> --archive-commit <commit>` | `commit` |

Behind: a goal's or prompt's material changed since it was created or confirmed, or a Node's `stale_after` passed. An output keeps what was seen when it was saved: later changes to its material or goals never make it behind, and a complete `node get` lists them. Ahead: nothing shows that a goal is carried out for its current body and material. A goal that owns a directory or prefix, itself or through a child goal, is carried out by that code while its body and materials stay as they were when it was created or confirmed; other goals need an undeprecated output saved or confirmed against them. Either clears ahead: confirm the goal once its code matches the change, confirm an output that still holds, or record a new one.

- On an ETag conflict, reread, merge and save with the new `etag`. A partial read's `read:` ETag cannot replace or confirm a body.
- `append --heading <title>` adds to the end of that section, or starts it.
- Add materials with the CLI; to remove one, delete its frontmatter entry.
- `--resource` is the main material, `sources` the rest. Pass Workspace-root paths (`docs/x.md`); Tent stores them Node-relative. A section (`docs/x.md#State`) ignores edits elsewhere in its file; a plain directory (`src/auth/`) only marks coverage, and edits inside never make the Node behind. A `goal` or `prompt` takes its grounds as material, not code; a `goal` may still own the code that carries it out, through a plain directory or prefix.
- `link-output` needs the file present in the Workspace checkout; merge a worktree branch first.
