# Find and read

| When | Command | Read |
| --- | --- | --- |
| A file | `tent node search --resource <path>` | `items[].nodeId` |
| Children or parent | `tent node relations <id> --direction children` (or `parent`) | `items[].nodeId` |
| Links in or out | `tent node relations <id> --direction incoming --json` (or `outgoing`) | `items[].from` for incoming, `items[].target` for outgoing: `kind`, `id`, or `workspacePath` for a file |
| A type or tag | `tent node list --type prompt --tag decision` | `items[].nodeId` |
| The tree | `tent node list`, then `--cursor <page.nextCursor>` | `items` |
| A Node's next page | `tent node get <id> --cursor <page.nextCursor>` | `text` |
| A whole Node | `tent node get <id> --full --json`; `--view raw` adds frontmatter | `text`, `etag`, `version` |

First-page and `--full` reads add `context` (at most 1 KiB): ancestors, children, links in and out, and Cards that pin the Node.

Open `node-`, `role-` and `card-` ids with `node get`, `role show` and `card show`.

`version` names the bytes you read: `tent node get <id> --version-json '<version>'` rereads them; `tent node history <id>` lists earlier ones.
