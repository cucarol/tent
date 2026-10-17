---
name: tent-init
description: "Creates a Tent in a workspace, enables its Hooks and maps existing code into modules. Use when asked to set up Tent for a project or map its modules."
---

# Tent Init

Run `tent` as [access](../../skill-resources/references/access.md) shows.

| When | Command | Read |
| --- | --- | --- |
| Pick the Workspace | The folder the user names, else the project root; reuse an existing `.tent/` | — |
| Create the Tent | `tent new <root>` | `Created Tent` line |
| Enable Hooks | Follow [Hooks](references/host-hooks.md) | `/hooks` |
| The project has code | [Map its modules](references/modules.md) | the map at the `tent ui` address |

Otherwise a new Tent starts with no Nodes; add them with tent-node as work produces facts.
