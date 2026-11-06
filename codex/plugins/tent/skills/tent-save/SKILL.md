---
name: tent-save
description: "Saves what work settled into Tent Nodes and corrects Nodes that no longer match their sources; also creates, moves or archives Nodes. Use when Tent lists Nodes at the end of a turn, or when work settles something later sessions should start from."
---

# Tent Save

Tent keeps the context of this project's agent sessions as a graph of Markdown Nodes in `.tent/`. Each Node records one real thing, and that thing is its source:

| type | Records | Its source |
| --- | --- | --- |
| `goal` | What the work is for: an intention it is committed to | What the user wants now |
| `prompt` | What is given to get there: requirements, constraints, decisions and their reasons, references, ways of working | The decisions made |
| `output` | What came out, as it is now: results, findings, known problems | The workspace, or what was found |

A prompt or output sits under the goal it serves.

Correct Nodes against their sources, not the reverse: a goal against what the user wants now, a prompt against the decisions made, an output against the workspace. Work that drifted from a goal the user still holds is something to tell the user, not to write into the goal. Leave a Node that still matches its source as it is: the user reads every edit in its history, and a rewording that corrects nothing is noise there.

## At the end of a turn

When this turn changed files, Tent lists the Nodes covering them, or says none does.

| When | Do |
| --- | --- |
| A sentence no longer matches its source | Fix it in the Node file |
| The turn settled something a later session should start from | Write it into the Node it belongs to, under the goal it serves |
| No Node holds it | `tent node create`, as below |
| You changed a goal | Tell the user what changed and why; a goal changes only when the user's will does |
| A lesson about particular lines | A comment beside them or a test, where whoever changes those lines will read it |
| None of these | Change nothing and say nothing about Tent: a check that changed nothing is noise to the user |

Process, hashes and test logs go in your reply: a later session starts from what holds now, not from how this turn got there. Tent also lists Node files it cannot read or whose references are gone; fix what it names.

## A Node file

A Node is one Markdown file at `.tent/<Parent>/<Name>/<Name>.md`. Read, search and edit Node files with your own tools.

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
| `type` | `goal`, `prompt` or `output`, as above |
| `description` | One sentence on what the Node holds; optional |
| `tags` | Words that help find it, none or several |
| `resource` | What the Node is about, if it is something in the workspace: a file, a Markdown section (`#Heading`) or a directory |
| `sources` | Where its facts come from, in the same forms |
| `status` | `deprecated` once archived |

Paths are relative to the Node file. When a file under `resource` or `sources` changes, Tent names the Node at the end of the turn; the most specific match wins. Link another Node by its id, as `[Login](node-k2m9qa)`.

## Commands

Run `tent` as [access](../../skill-resources/references/access.md) shows.

| When | Command |
| --- | --- |
| A new Node | `tent node create <name> --type <type> [--parent <id>] [--description <text>] [--tags a,b] [--resource <path>] [--source <path>]... --body -` |
| Rename or move | `tent node rename <id> <name>`, `tent node move <id> --parent <id\|root>` |
| Retire a subtree, or remove a Node | `tent node archive <id>`, `tent node delete <id>` |
| Earlier versions | `tent node history <id>`; add `--version <v>` to print one |
| Problems in the graph | `tent workspace check` |

`--resource` and `--source` take Workspace-root paths such as `src/auth/`; Tent stores them relative to the Node file. To bring back an archived Node, delete its `status: deprecated` line.

## How to write

Put one separately used fact in a Node, under the Node it narrows, and link instead of retelling. Split Nodes by the work that uses them, not by size. Name a Node for what it holds, in a few words the user would say; Tent's history already keeps when and who.
