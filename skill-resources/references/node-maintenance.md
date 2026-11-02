# Save Nodes

| When | Command | Read |
| --- | --- | --- |
| Change materials or fields | `tent node write <id> --input-json -` with `{"baseEtag":"<etag>","frontmatter":{"sources":[{"resource":"docs/a.md"}]}}` | `etag` |
| Several Nodes in one commit | `tent node write-many --input-json -` with `{"items":[{"op":"create","ref":"a","name":"<name>","type":"prompt","body":"..."},{"op":"update","nodeId":"<id>","baseEtag":"<etag>","body":"..."}]}` | `results[].nodeId` |
| Rename or move | `tent node rename <id> <name>`, `tent node move <id> --parent <id>` | the id stays |
| Retire a subtree | `tent node archive <id>`; to bring a Node back, delete its `status: deprecated` line | `commit` |

- On an ETag conflict, reread, merge and save with the new `etag`. A partial read's `read:` ETag cannot replace a body.
- `append --heading <title>` adds to the end of that section, or starts it.
- Add materials with the CLI; to remove one, delete its frontmatter entry.
- `--resource` is the main material, `sources` the rest. Pass Workspace-root paths (`docs/x.md`); Tent stores them Node-relative. A section (`docs/x.md#State`) ignores edits elsewhere in its file; a plain directory (`src/auth/`) only marks coverage. A `goal` or `prompt` takes its grounds as material, not code; a `goal` may still own the code that carries it out.
- `link-output` needs the file present in the Workspace checkout; merge a worktree branch first.
