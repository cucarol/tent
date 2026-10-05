---
name: tent-node
description: "Read the Tent Nodes a task needs before working, and save the decisions, rules, results and problems from the work as Nodes for later work."
---

# Tent Node

Nodes hold project context that should outlast one conversation. Run the
[bundled CLI](../../skill-resources/references/access.md) against the existing
Workspace.

## Before working

1. For the current situation, run `tent workspace brief`: behind and ahead
   Nodes, pending Cards and recent files not yet recorded. Otherwise start
   from a Node the user, a Role or a Card points to, or a focused
   `tent node search`.
2. Read those Nodes, following links only as far as the task needs
   ([finding context](../../skill-resources/references/input.md)).
3. Treat each by its [type](../../skill-resources/references/node-types.md):
   work toward `goal`, follow `prompt`, check `output` against its material.

## After working

Update only the Nodes your work affected
([saving](../../skill-resources/references/node-maintenance.md)):

- A new confirmed intent, rule, decision, result or problem: update the Node
  that owns the fact, or create one.
- A fact your work made wrong: correct it.
- A result that implements a goal:
  `tent node link-output <goal-id> --resource <path>`.
- A behind Node whose judgment still holds after you read the changed
  material: `tent node confirm`. If the judgment changed, save the correction
  with `node write --confirm`. A plain save does not clear behind.
- A decision: make it within your Role, or send a Card to the Role that owns
  it; do not stop to wait for the user. Record it in a Node; the user may
  still change it.
- Nothing changed: leave the Nodes alone.

Add text with `node append` and change one heading with `node write-section`.
Before replacing a whole body, read it with `tent node get <id> --full --json`
and write with that ETag. Afterwards run `tent workspace check --json` once.

## Writing

- Open with what the Node is and how to use it, state facts directly, and
  label anything unverified.
- Keep one Node per independently useful fact, and facts that change together
  in one Node; the parent sets scope. Link to material and other Nodes
  instead of retelling them.
- `goal` and `prompt` hold confirmed intent, decisions and reasons. Commit
  ids, test counts and delivery status belong to Git and Cards; keep useful
  verification as dated `output` evidence. Under a goal, only results that
  implement it are `output`; its questions and research are `prompt`.
- Never enter hashes; Tent records versions. Your confirmations are machine
  confirmations; pass `--by human:<id>` only for a person's actual review.

Ordinary work needs neither a Role nor a Card; see
[tent-role](../tent-role/SKILL.md) and [tent-card](../tent-card/SKILL.md).
