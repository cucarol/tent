---
name: tent-role
description: "Takes on, creates or maintains a Tent Role, a continuing work direction that receives Cards. Use when told to work as a Role or to set one up."
---

# Tent Role

Run `tent` as [access](../../skill-resources/references/access.md) shows.

| When | Command | Read |
| --- | --- | --- |
| Given a Role name | `tent role list --json` | `items[].roleId` by `title`; skip `status: deprecated` |
| Starting as a Role | `tent role show <role-id>` | `text`, then the Nodes it links |
| Looking for work | `tent card list --role <role-id> --include-open --state pending` | `items[].cardId` |
| A new direction | `tent role create --title <title> --body -` | `roleId` |
| Update or retire | [Role commands](../../skill-resources/references/roles.md) | `etag` |

A Role body holds purpose, boundaries, methods and Node links; shared facts live in Nodes. Decide inside those boundaries; send a Card to the Role that owns any other decision.
