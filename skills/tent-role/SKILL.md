---
name: tent-role
description: "Take on, create or maintain a Tent Role: a continuing work direction, such as UI or release, that carries its context across conversations and can receive Cards."
---

# Tent Role

A Role keeps one continuing direction of work: its purpose, boundaries,
methods and entry points into the relevant Nodes. Commands:
[Role reference](../../skill-resources/references/recipients.md).

## Work as a Role

1. Read it: `tent role show <role-id>`.
2. List its waiting Cards with
   `tent card list --role <role-id> --include-open --state pending`, and
   handle them through [tent-card](../tent-card/SKILL.md), which also says how
   to wait for new ones.
3. Read the Nodes the Role and its Cards point to, as the task needs.

A Role is context, not a lock: other conversations can work as the same Role.

## Create or maintain

Create one when a direction will continue across conversations:
`tent role create --title <title> --body -`. Keep the body short: purpose,
boundaries (including what needs the user's decision), methods, and links to
the Nodes that hold its facts. Shared facts stay in
[Nodes](../tent-node/SKILL.md); received Cards are listed by
`tent card list --role <role-id> --state consumed`.
