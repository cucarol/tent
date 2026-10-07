---
name: tent-init
description: "Create an empty Tent in a workspace and set up host access to its bundled CLI and Hooks."
---

# Tent Init

Use when asked to set up Tent. Resolve `tent` with [runtime access](../../skill-resources/references/access.md).

| When | Run / do | Check |
| --- | --- | --- |
| Choose location | Use the named folder or project root; reuse existing `.tent/` | Pass `--workspace <root>` from other directories |
| Initialize | `tent new <root>` | Success; never create `.tent/` by hand |
| Verify | `tent node list --workspace <root> --json` | `items: []` is valid for a new Tent |
| Enable Hooks | Follow [host integration](references/host-hooks.md) | Distinguish configured from observed running |
| Continue work | Use [tent-node](../tent-node/SKILL.md) | Save facts from real work; do not seed Nodes by scanning the project |

Update through the host as a whole plugin; preserve user-disabled Hooks.
Maintainer background: [plugin guide](../../docs/PLUGIN.md).
