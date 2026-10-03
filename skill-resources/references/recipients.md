# Role commands

A Role is one Markdown document at `.tent/roles/<role-id>.md`, and that
document is the authority for its direction. Shared project facts stay in
Nodes.

```text
tent role list
tent role create --title <title> --body -
tent role show <role-id>
tent role show <role-id> --view raw
tent role write <role-id> --body - --base-etag <etag>
tent role write <role-id> --status deprecated --base-etag <etag>
```

All commands accept `--workspace`.

- `list` returns each Role's id, title and status.
- `show` returns one page of the body, or of the whole document with
  `--view raw`, together with its ETag and Git version. When `page.next` is
  present, continue with its view, range (`--start`, `--end`) and
  `--expected-etag`.
- `write` needs the ETag from your latest `show`. On a conflict, read the Role
  again, merge your change into the new text and write with the new ETag.
- A missing or invalid Role is reported as an error; nothing is created or
  repaired on read.

A Role's received Cards are found through the Cards themselves:
`tent card list --role <role-id> --state consumed`, or `--state interrupted`.
