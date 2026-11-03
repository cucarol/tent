# Role commands

| When | Do | Read |
| --- | --- | --- |
| Read or edit a Role | Open `.tent/roles/<role-id>.md` with your own tools | frontmatter `title` and `status`; the body |
| Retire | Clear its Cards: take results returned to it, finish returns it owes, cancel and resend its pending Cards. Then set `status: deprecated` in its file | `tent workspace check` names Cards still in the way |
| Remove for good | `tent role delete <role-id>` | `PENDING_CARDS` names Cards still in the way |
