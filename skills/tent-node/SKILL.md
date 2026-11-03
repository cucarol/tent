---
name: tent-node
description: "Records what a change settled in Tent Nodes, and creates, moves or archives Nodes when the user asks. At the end of a turn Tent names the Nodes covering the files you changed; ordinary work needs no Tent command."
---

# Tent Node

A Node is one Markdown file in `.tent/`, at `.tent/<Parent>/<Name>/<Name>.md`. Read, search and edit Node files with your own tools. Run `tent` as [access](../../skill-resources/references/access.md) shows, only for the commands below.

## At the end of a turn

When this turn changed files that Nodes cover, Tent lists those Nodes with their paths. Read the ones the change touches.

| When | Do |
| --- | --- |
| A sentence is now wrong | Fix it in the Node file |
| The work settled something lasting: a rule and why, a rejected option and why, a dead end that binds later work | Write it into the Node it belongs to |
| No Node holds it | `tent node create`, as below |
| A lesson about particular lines | A code comment or a test, not a Node |
| None of these | Change nothing and say nothing about Tent |

Tent also lists Node files it cannot read; fix what it names. Process, hashes and test logs go in your report.

## A Node file

```markdown
---
id: node-abc123
type: prompt
description: How users sign in.
tags: [decision, login]
resource: ../../../src/auth/
sources:
  - resource: ../../../docs/login.md#Codes
---
Users sign in with email and a one-time code, agreed with the user on 2026-10-08 for [Login](node-k2m9qa).
Unverified: whether SSO skips the code.
```

| Field | Holds |
| --- | --- |
| `id` | Tent's id for the Node; never change it |
| `type` | `goal`, `prompt` or `output`, as the word says |
| `description` | One sentence on what the Node holds; optional |
| `tags` | Words that help find it, none or several |
| `resource` | What the Node is about: a file, a Markdown section (`#Heading`) or a directory |
| `sources` | Where its facts come from, in the same forms |
| `status` | `deprecated` once archived |

Paths are relative to the Node file. When a file under `resource` or `sources` changes, Tent names the Node; the most specific match wins. Link another Node by its id, as `[Login](node-k2m9qa)`.

## Commands

| When | Command |
| --- | --- |
| A new Node | `tent node create <name> --type <type> [--parent <id>] [--description <text>] [--tags a,b] [--resource <path>] [--source <path>]... --body -` |
| Rename or move | `tent node rename <id> <name>`, `tent node move <id> --parent <id\|root>` |
| Retire a subtree, or remove a Node | `tent node archive <id>`, `tent node delete <id>` |
| Earlier versions | `tent node history <id>`; add `--version <v>` to print one |
| Problems in the graph | `tent workspace check` |

`--resource` and `--source` take Workspace-root paths such as `src/auth/`; Tent stores them relative to the Node file. To bring back an archived Node, delete its `status: deprecated` line.

## How to write

Put one separately used fact in a Node, under the Node it narrows, and link instead of retelling. Name it for what it holds, in a few words the user would say; Tent's history already keeps when and who.
