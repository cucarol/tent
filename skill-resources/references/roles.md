# Role commands

| When | Command | Read |
| --- | --- | --- |
| Read a Role | `tent role show <role-id>`; continue with `page.next` as `--start`, `--end`, `--expected-etag` | `text`, `etag` |
| Replace the body | `tent role write <role-id> --base-etag <etag> --body -` | `etag` |
| Retire | Clear its Cards first: take returned receipts, finish outstanding returns, `tent card move <card-id> --to <role-id>` pending ones; then `tent role write <role-id> --status deprecated --base-etag <etag>` | `etag`; `PENDING_CARDS` names the Cards still in the way |

On an ETag conflict, read again, merge and write with the new `etag`.
