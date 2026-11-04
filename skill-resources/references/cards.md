# Card commands

| When | Command | Read |
| --- | --- | --- |
| Pending work only | `tent card list --role <role-id> --state pending` | `items[].cardId`, in queue order |
| Cancel | `tent card deprecate <card-id>` | `status` |
| A Card as sent | Open `.tent/cards/<card-id>.md` | frontmatter `state` and `result`; the body is the task |

- `state` tracks delivery only: `pending`, then `consumed` when taken. Without `returnTo`, `consumed` is complete. With it, the receiver returns the Card (`returned`) and the `returnTo` Role takes it again to close it (`closed`).
- A Card with `returnTo` needs a receiving Role other than its `returnTo`. Repeating the same take or return is a replay; a different result is rejected.
- Each Role's pending Cards form a queue, oldest first. To send a pending Card elsewhere, cancel it and send it again.
- Cancelling does not reach a receiver that already took the Card; `notice` on its `take` marks a cancelled Card.
- A Role with unfinished Cards cannot be deleted; cancel those Cards first.
- Continue a paged `list` with `--start <page.next>`.
