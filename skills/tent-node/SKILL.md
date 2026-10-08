---
name: tent-node
description: "Reads and records context as Tent Nodes. Use when a task needs Tent context, or work produced a decision, rule, result or problem."
---

# Tent Node

Run `tent` as [access](../../skill-resources/references/access.md) shows.

## Before working

| When | Command | Read |
| --- | --- | --- |
| No pointer | `tent workspace brief` | `behind`, `ahead`, `cardInputs` |
| A Node id | `tent node get <id>` | `text`, `etag`, `context` |
| A topic | `tent node search "<term>"` | `items` |

Treat each Node by its [type](../../skill-resources/references/node-types.md). More reads: [input](../../skill-resources/references/input.md).

## After working

Update only the Nodes your work touched; if nothing changed, change nothing.

| When | Command | Read |
| --- | --- | --- |
| Add text | `tent node append <id> --heading <title> --body -` | `etag` |
| Edit a section | `tent node get-section <id> --heading <title>`, then `tent node write-section <id> --heading <title> --base-etag <sectionEtag> --body -` with the whole section, heading included | `sectionEtag`, then `etag` |
| Rewrite, or confirm a behind Node that holds | `tent node get <id> --full --json`, then `tent node write <id> --base-etag <etag> --body -` or `tent node confirm <id> --base-etag <etag>` | `etag` |
| New fact | `tent node create <name> --type <type> [--parent <id>] --tags <tag> --body -` | `node.nodeId` |
| A file implements a goal | `tent node link-output <goal-id> --resource <path> --tags asset` | `nodeId` |

More: [saving](../../skill-resources/references/node-maintenance.md). After saving, run `tent workspace check --json` once and fix what it lists.

## How to write

One Node per separately used fact, under the Node it narrows; link instead of retelling. Example:

```markdown
Sign-in rules; follow them when changing login.
Users sign in with email and a one-time code.
Agreed with the user on 2026-10-08 for [Login](node-abc123).
Unverified: whether SSO skips the code.
```
