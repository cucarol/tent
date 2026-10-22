# Find and read

| When | Command | Read |
| --- | --- | --- |
| Rules for a file to change | `tent node search --resource <path>`, most specific first | `items[].nodeId`, `path` |
| Children or parent | `tent node relations <id> --direction children` (or `parent`) | `items[].nodeId`, `path` |
| Links in or out | `tent node relations <id> --direction incoming --json` (or `outgoing`) | `items[].from` for incoming, `items[].target` for outgoing: `kind`, `id`, or `workspacePath` for a file |
| A type or tag | `tent node list --type prompt --tag decision` | `items[].nodeId`, `path` |
| The tree | `tent node list`, then `--cursor <page.nextCursor>` | `items` |
| A Node's next page | `tent node get <id> --cursor <page.nextCursor>` | `text` |
| A whole Node | `tent node get <id> --full --json`; `--view raw` adds frontmatter | `text`, `etag`, `materials` |
| Its surroundings | `tent node get <id> --context` | ancestors, children, links, Cards |

Node reads show each declared material below ETag as `Material: <path>`; JSON exposes `materials`. Local paths are decoded and Workspace-relative, without loading material bodies. Complete output reads report changes to own materials and only the nearest goal; higher goal comparison data remains retained.

Every `path` outside `version` is Workspace-relative. Open `node-`, `role-` and `card-` ids with `node get`, `role show` and `card show`.

`tent node history <id>` lists earlier versions; `tent node get <id> --version-json '<version>'` reads one.
