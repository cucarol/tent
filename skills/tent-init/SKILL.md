---
name: tent-init
description: "Creates a Tent in a workspace, enables its Hooks and maps an existing project into parts. Use when asked to set up Tent for a project or map it."
---

# Tent Init

Run `tent` as [access](../../skill-resources/references/access.md) shows.

| When | Command | Read |
| --- | --- | --- |
| Pick the Workspace | The folder the user names, else the project root; reuse an existing `.tent/` | — |
| Create the Tent | `tent new <root>` | `Created Tent` line |
| Enable Hooks | Follow [Hooks](references/host-hooks.md) | `/hooks` |
| The project already has files | [Map it](references/map.md) | the map at the `tent ui` address |

A project with no files yet starts with no Nodes; add them with tent-node as work produces facts.
