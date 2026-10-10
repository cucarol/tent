# Find and read

| When | Command | Read |
| --- | --- | --- |
| A file | `tent node search --resource <path>` | `items[].nodeId`, `path` |
| Children or parent | `tent node relations <id> --direction children` (or `parent`) | `items[].nodeId`, `path` |
| Links in or out | `tent node relations <id> --direction incoming --json` (or `outgoing`) | `items[].from` for incoming, `items[].target` for outgoing: `kind`, `id`, or `workspacePath` for a file |
| A type or tag | `tent node list --type prompt --tag decision` | `items[].nodeId`, `path` |
| The tree | `tent node list`, then `--cursor <page.nextCursor>` | `items` |
| A Node's next page | `tent node get <id> --cursor <page.nextCursor>` | `text` |
| A whole Node | `tent node get <id> --full --json`; `--view raw` adds frontmatter | `text`, `etag` |
| Its surroundings | `tent node get <id> --context` | ancestors, children, links, Cards |

Every `path` outside `version` is Workspace-relative. Open `node-`, `role-` and `card-` ids with `node get`, `role show` and `card show`.

`tent node history <id>` lists earlier versions; `tent node get <id> --version-json '<version>'` reads one.
