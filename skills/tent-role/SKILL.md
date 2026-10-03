---
name: tent-role
description: "Take on, create or maintain a Tent Role: a continuing work direction, such as UI or release, that carries its context across conversations and can receive Cards."
---

# Tent Role

A Role keeps one continuing direction of work: its purpose, boundaries,
working methods and entry points into the relevant Nodes. Use the
[bundled CLI](../../skill-resources/references/access.md) and
[Role commands](../../skill-resources/references/recipients.md).

## Work as a Role

When the user asks you to take on or continue a Role:

1. Read it: `tent role show <role-id>`.
2. Check its waiting inputs:
   `tent card list --role <role-id> --include-open --state pending`.
3. Preview each Card with `tent card show <card-id>`, and take it when you
   start acting on it; see [tent-card](../tent-card/SKILL.md).
4. Read the Nodes the Role and its Cards point to, as the task needs them.

The Role is context, not a lock. It does not bind your Session, reserve a
task or own a worktree, and other conversations can work as the same Role.

## Create or maintain a Role

Create a Role when a direction will continue across conversations:
`tent role create --title <title> --body -`. Keep the body short:

- **Purpose**: what this direction is responsible for.
- **Boundaries**: what it does not own, and what needs the user's decision.
- **Methods**: how work in this direction is done.
- **Entry points**: links to the Nodes that hold its facts.

Put shared project facts in [Nodes](../tent-node/SKILL.md) and link to them.
A Role's received Cards are listed by
`tent card list --role <role-id> --state consumed`; do not copy them into the
Role.
