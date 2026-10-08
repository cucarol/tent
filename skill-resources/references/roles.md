# Role commands

| When | Command | Read |
| --- | --- | --- |
| Read a Role | `tent role show <role-id>`; continue with `page.next` as `--start`, `--end`, `--expected-etag` | `text`, `etag` |
| Replace the body | `tent role write <role-id> --base-etag <etag> --body -` | `etag` |
| Retire | `tent role write <role-id> --status deprecated --base-etag <etag>` | `etag` |

On an ETag conflict, read again, merge and write with the new `etag`.
