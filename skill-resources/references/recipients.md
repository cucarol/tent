# Role commands

A Role is one document at `.tent/roles/<role-id>.md`, and its body is the
authority for its direction. Shared project facts stay in Nodes.

```text
tent role list
tent role create --title <title> --body -
tent role show <role-id> [--view raw]
tent role write <role-id> --body - --base-etag <etag>
tent role write <role-id> --status deprecated --base-etag <etag>
```

All commands accept `--workspace`. `write` needs the ETag from your latest
`show`; on a conflict, read again and merge. A Role's received Cards are
listed by `tent card list --role <role-id> --state consumed`.
