# Role commands

All commands accept `--workspace <root>` and `--json`.

| When | Command | Read |
| --- | --- | --- |
| Find id | `tent role list` | `items[].roleId`, `title` |
| Create | `tent role create --title <title> --body -` | `roleId`, `etag` |
| Read | `tent role show <role-id> [--view raw]` | `text`, `etag`, `page.next` |
| Replace body | `tent role write <role-id> --body - --base-etag <etag>` | Saved receipt |
| Retire | `tent role write <role-id> --status deprecated --base-etag <etag>` | Saved receipt |

- Pass multiline bodies through stdin (`-`).
- Finish a paged `show` with `--start N --end N --expected-etag <etag>` from `page.next`; keep the same view.
- Continue `list` with `--start N --expected-revision <revision>` from `page.next`.
- Before replacing a body, read it completely. On ETag conflict, read again and merge.
- Find received Cards with `tent card list --role <role-id> --state consumed`.

Maintainer background: [plugin guide](../../docs/PLUGIN.md).
