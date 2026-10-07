# Card commands

All commands accept `--workspace <root>` and `--json`.

| When | Command | Read |
| --- | --- | --- |
| Send | `tent card create --prompt - [--source <node-id\|path\|JSON>]... [--target <role-id>] [--title <text>]` | `cardId` |
| Find work | `tent card list [--role <role-id> --include-open] [--state pending\|consumed] [--include-deprecated]` | `items`, `page.next` |
| Preview | `tent card show <card-id> [--view raw]` | `text`, `sources`, `etag`, `page.next` |
| Receive | `tent card take <card-id> [--role <role-id>]` | `replayed`, `state`, `progress` |
| Transfer pending work | `tent card move <card-id> (--to <role-id> \| --public) --base-etag <etag>` | Receipt |
| Cancel | `tent card deprecate <card-id> --base-etag <etag>` | Receipt |
| Wait | `tent card watch --role <role-id> [--timeout <seconds>]` | Exit 0: Cards and `take` commands; 2: timeout; 1: error |

- Repeat `--source` in reading order. Use Node ids or Workspace paths (`.tent/Area/Topic/Topic.md`, `docs/req.md`); `./docs/req.md` and `/docs/req.md` also start at the Workspace root. JSON `{"resource":"..."}` uses the same rules; external absolute paths need `file:` URIs.
- A targeted Card requires its Role to take it; a public Card may omit `--role`. Read pinned Nodes with `tent node get <node-id> --version-json '<source.version JSON>' --json`; a changed-source brief asks for a current read.
- Continue show/take text using `card show` with `--start N --end N --expected-etag <etag>` from `page.next` (same view); continue list with `--start N --expected-revision <revision>`. Move/cancel use the latest show `etag`. On conflict, read again; never edit published input (`INPUT_CHANGED`).
- Check `progress`: `received-no-output` needs results; `needs-review` needs rereading changed material; `has-output` needs checking actual results. `goalCount/totalGoalCount` counts satisfied/requested goals. Record via `tent node link-output <goal-id> --resource <path> --card <card-id>`; without goal sources only reception is tracked.
- Watch sees committed pending Cards addressed to that Role, excluding deprecated Cards. Omit timeout to wait; `0` checks once. It does not include public Cards; use list `--include-open` for those.

Maintainer background: [plugin guide](../../docs/PLUGIN.md).
