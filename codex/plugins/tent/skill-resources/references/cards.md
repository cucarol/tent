# Card commands

| When | Command | Read |
| --- | --- | --- |
| Pending work | `tent card list --role <role-id> --include-open --state pending` | `items[].cardId`, in queue order |
| Received work | `tent card list --role <role-id> --state consumed` | `items[].returnTo`: set means a return is still owed |
| Read a pinned source | `tent node get <node-id> --version-json '<sources[].version>'` | `text` |
| Hand a pending Card on | `tent card move <card-id> --to <role-id> --base-etag <etag>` (or `--public`) | `etag` |
| Reorder a queue | `tent card move <card-id> --before <card-id> --base-etag <etag>` (or `--after`; add `--to` or `--public` to place it in another queue) | `etag` |
| Cancel | `tent card deprecate <card-id> --base-etag <etag>` | `status` |

- `--source` takes a Node id or a Workspace-root path such as `docs/req.md`; Nodes are pinned to their current version.
- `state` tracks delivery only: `pending`, then `consumed`. Without `returnTo`, `consumed` is complete. With it, the receiver returns the Card (`returned`) and the `returnTo` Role takes it again to close it (`closed`). Goal progress lives on the goals, not on Cards.
- A Card with `returnTo` needs a receiving Role other than its `returnTo`. Repeating the same return is a replay; a different result is rejected, so put corrections in a Node.
- Each Role's pending Cards form a queue, oldest first unless someone reordered it. Untargeted Cards form the public area: it wakes no Role, and the first Role to take a Card there claims it.
- A Role with unfinished Cards cannot be deleted; deprecate those Cards, or move pending ones.
- Continue a paged `show` or `list` with the `page.next` values as `--start`, `--end`, `--expected-etag` or `--expected-revision`.
- `notice` on `show` or `take` marks a cancelled Card.
