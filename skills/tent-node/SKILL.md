---
name: tent-node
description: "Reads and records context as Tent Nodes. Use when a task needs Tent context, or work produced a decision, rule, result or problem."
---

# Tent Node

Run `tent` as [access](../../skill-resources/references/access.md) shows.

## Before working

| When | Command | Read |
| --- | --- | --- |
| No pointer | `tent workspace brief` | `behind`, `ahead`, `cardInputs`, then `roots` |
| A `path` | Read the file with your own reader | text |
| Only a Node id | `tent node get <id>` | `text`, `etag` |
| A topic | Search `.tent/` with your own search tool | `path` |
| Before changing a file | `tent node search --resource <file>` | each `path`; read that Node and its parents |

Treat each Node by its [type](../../skill-resources/references/node-types.md). More reads: [input](../../skill-resources/references/input.md).

## After working

Update only the Nodes your work touched; if nothing changed, change nothing. Write what now holds into the Node that governs that code or task: a rule and why, a rejected option and why, a dead end. Process, hashes and acceptance logs go in your report or Card return; the Node keeps a link to the report when it rests on one.

| When | Command | Read |
| --- | --- | --- |
| Change text | Edit the file with your own editor; Tent records it at its next write, brief or check | |
| Add a section without reading | `tent node append <id> --heading <title> --body -` | `etag` |
| A behind Node still holds | `tent node get <id> --full --json`, then `tent node confirm <id> --base-etag <etag>` | `etag` |
| New fact | `tent node create <name> --type <type> [--parent <id>] --tags <tag> --body -` | `node.nodeId` |
| A file implements a goal | `tent node link-output <goal-id> --resource <path> --tags asset` | `nodeId` |

No edit clears behind; only `confirm` does. More: [saving](../../skill-resources/references/node-maintenance.md). After saving, run `tent workspace check --json` once and fix what it lists.

## How to write

One Node per separately used fact, under the Node it narrows; link instead of retelling. Name it for what it holds, in a few words the user would say; Tent's history already keeps when and who. Example:

```markdown
Sign-in rules; follow them when changing login.
Users sign in with email and a one-time code.
Agreed with the user on 2026-10-08 for [Login](node-abc123).
Unverified: whether SSO skips the code.
```
