---
name: tent-init
description: "Create an empty Tent in a workspace and set up host access to its bundled CLI and Hooks."
---

# Tent Init

Use this when the user asks to set up Tent for a project. The CLI is described
in [runtime access](../../skill-resources/references/access.md).

1. Choose the root: the folder the user named, or the project root. Reuse an
   existing `.tent/`.
2. Run `tent new <root>`. It creates `.tent/` with its own Git history and no
   Nodes; never create it by hand.
3. Confirm with `tent node list --workspace <root> --json`; an empty list
   means Tent works.
4. For Hooks, follow [host integration](references/host-hooks.md). Report
   what works now separately from what waits on a host reload or trust review.

Start empty: Nodes form from real work through
[tent-node](../tent-node/SKILL.md), not from analyzing the project. The folder
holding `.tent/` is the Workspace every path resolves from; pass
`--workspace <root>` when your shell runs elsewhere. Update the plugin as a
whole through its host, and keep any Hooks the user disabled. Then continue
with the user's original task.
