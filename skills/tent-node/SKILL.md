---
name: tent-node
description: "Records what a change settled in Tent Nodes, and runs Tent reads or writes the user asks for. Tent's hooks already show the Nodes that cover each changed file; ordinary code work needs no Tent command."
---

# Tent Node

Run `tent` as [access](../../skill-resources/references/access.md) shows.

## After a change

Tent shows the Nodes that cover each file you change, with their text, right after the change. Work from that text. When the work is done, change Nodes only if it made a sentence wrong or settled something lasting; otherwise change nothing and say nothing about Tent.

| When | Do |
| --- | --- |
| A sentence is now wrong | Edit it in the Node file with your own editor |
| A rule and why, a rejected option and why, or a dead end that binds code outside this change | `tent node append <id> --heading <title> --body -` on the Node that governs that code |
| A lesson about particular lines | A code comment or a test, not a Node |
| A file implements a goal | `tent node link-output <goal-id> --resource <path> --tags asset` |
| A new fact no Node holds | `tent node create <name> --type <type> [--parent <id>] --tags <tag> --body -` |

Make the Node changes together, once, at the end. Tent reports a problem in a Node right after you write it; fix what it names. Process, hashes and acceptance logs go in your report or Card return; the Node links to the report when it rests on one. More: [saving](../../skill-resources/references/node-maintenance.md), [types](../../skill-resources/references/node-types.md).

## When asked

| Asked for | Command |
| --- | --- |
| What changed and what waits | `tent workspace brief` |
| A Node by id | `tent node get <id>` |
| The rules for a file | `tent node search --resource <file>` |
| A behind Node still holds | `tent node get <id> --full --json`, then `tent node confirm <id> --base-etag <etag>` |

More: [input](../../skill-resources/references/input.md).

## How to write

One Node per separately used fact, under the Node it narrows; link instead of retelling. Name it for what it holds, in a few words the user would say; Tent's history already keeps when and who. Example:

```markdown
Sign-in rules; follow them when changing login.
Users sign in with email and a one-time code.
Agreed with the user on 2026-10-08 for [Login](node-abc123).
Unverified: whether SSO skips the code.
```
