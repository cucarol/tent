---
name: tent-init
description: "Create an empty Tent in a workspace and set up host access to its bundled CLI and Hooks."
---

# Tent Init

Use this when the user asks to set up Tent for a project. See
[runtime access](../../skill-resources/references/access.md) for the launcher.

1. Choose the root: the folder the user named, or the current project root.
   If it already contains `.tent/`, reuse it.
2. Create it with `tent new <root>`. This makes `.tent/` with its own local Git
   history at `.tent/.git`, and no Nodes. Let the CLI write `.tent/`; do not
   create it by hand.
3. Confirm access with `tent node list --workspace <root> --json`. An empty
   list means Tent is working.
4. For automatic Hooks, follow [host integration](references/host-hooks.md).
   Report what works now separately from what waits on a host reload or trust
   review.

Start with an empty graph. Nodes form as decisions, references and results
come up in real work, through [tent-node](../tent-node/SKILL.md); setup itself
does not analyze the project or add placeholder Nodes.

The folder containing `.tent/` is the Workspace that all material paths use,
including for nested or non-Git projects. When your shell runs elsewhere, pass
`--workspace <root>`. Update the plugin as a whole through its host; its
Skills are not installed one by one. Keep unrelated host settings and any
Hooks the user disabled.

After setup, continue with the user's original task.
