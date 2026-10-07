---
name: tent-role
description: "Take on, create or maintain a Tent Role: a continuing work direction that can receive Cards."
---

# Tent Role

| When | Run / do | Check |
| --- | --- | --- |
| Given a name | `tent role list --json` | Use its `items[].roleId`, not its title |
| Start as a Role | `tent role show <role-id> --json` | Read `text` and the linked Nodes needed for this task |
| Find work | `tent card list --role <role-id> --include-open --state pending` | Receive through [tent-card](../tent-card/SKILL.md); wait there when idle |
| Review received work | `tent card list --role <role-id> --state consumed` | Check progress and actual outputs |
| Create a continuing direction | `tent role create --title <title> --body -` | Save returned `roleId` |
| Update or retire | Use [Role commands](../../skill-resources/references/recipients.md) | Read latest `etag` before writing |

Keep the body to purpose, boundaries, methods and Node links. Save shared facts through [tent-node](../tent-node/SKILL.md).
Maintainer background: [plugin guide](../../docs/PLUGIN.md).
