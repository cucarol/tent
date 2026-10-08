# Card commands

| When | Command | Read |
| --- | --- | --- |
| Pending work | `tent card list --role <role-id> --include-open --state pending` | `items[].cardId` |
| Received work | `tent card list --role <role-id> --state consumed` | `items[].progress` |
| Read a pinned source | `tent node get <node-id> --version-json '<sources[].version>'` | `text` |
| Hand a pending Card on | `tent card move <card-id> --to <role-id> --base-etag <etag>` (or `--public`) | `etag` |
| Cancel | `tent card deprecate <card-id> --base-etag <etag>` | `status` |

- `--source` takes a Node id or a Workspace-root path such as `docs/req.md`; Nodes are pinned to their current version.
- `progress`: `received-no-output` needs a result, `needs-review` needs a look at changed outputs, `has-output` means each goal source has a current output; `goalCount` of `totalGoalCount` are done.
- Continue a paged `show` or `list` with the `page.next` values as `--start`, `--end`, `--expected-etag` or `--expected-revision`.
- `notice` on `show` or `take` marks a cancelled Card.
