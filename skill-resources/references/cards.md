# Card commands

| When | Command | Read |
| --- | --- | --- |
| Pending work | `tent card list --role <role-id> --include-open --state pending` | `items[].cardId` |
| Received work | `tent card list --role <role-id> --state consumed` | `items[].returnTo`: set means a return is still owed |
| Read a pinned source | `tent node get <node-id> --version-json '<sources[].version>'` | `text` |
| Hand a pending Card on | `tent card move <card-id> --to <role-id> --base-etag <etag>` (or `--public`) | `etag` |
| Cancel | `tent card deprecate <card-id> --base-etag <etag>` | `status` |

- `--source` takes a Node id or a Workspace-root path such as `docs/req.md`; Nodes are pinned to their current version.
- `state` tracks delivery only: `pending`, then `consumed`. Without `returnTo`, `consumed` is complete. With it, the receiver returns the Card (`returned`) and the `returnTo` Role takes it again to close it (`closed`). Goal progress lives on the goals, not on Cards.
- A Card with `returnTo` needs a receiving Role other than its `returnTo`. Repeating the same return is a replay; a different result is rejected, so put corrections in a Node.
- A Role with unfinished Cards cannot be deleted; deprecate those Cards, or move pending ones.
- Continue a paged `show` or `list` with the `page.next` values as `--start`, `--end`, `--expected-etag` or `--expected-revision`.
- `notice` on `show` or `take` marks a cancelled Card.
