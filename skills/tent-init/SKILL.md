---
name: tent-init
description: "Creates an empty Tent in a workspace and enables its Hooks. Use when asked to set up or install Tent for a project."
---

# Tent Init

Run `tent` as [access](../../skill-resources/references/access.md) shows.

| When | Command | Read |
| --- | --- | --- |
| Pick the Workspace | The folder the user names, else the project root; reuse an existing `.tent/` | — |
| Create the Tent | `tent new <root>` | `Created Tent` line |
| Verify | `tent node list --workspace <root>` | `items: []` |
| Enable Hooks | Follow [Codex Hooks](references/host-hooks.md) | `/hooks` |

A new Tent starts with no Nodes; add them with tent-node as work produces facts.
