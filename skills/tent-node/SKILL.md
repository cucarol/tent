---
name: tent-node
description: "Read the Tent Nodes a task needs before working, and save the decisions, rules, results and problems from the work as Nodes for later work."
---

# Tent Node

Nodes hold the project context that should outlast one conversation. Use the
existing Workspace and the [bundled CLI](../../skill-resources/references/access.md).

## Before working: read what the task needs

1. Use `tent workspace brief` when you need the current situation: state
   counts, behind Nodes, ahead age, recent inputs/outputs and input Cards.
   Otherwise start from a Node linked from a Role or Card, a Node the user
   named, or a focused `tent node search`.
2. Read those bodies. Follow links, parents or children only as far as the
   task needs; see [context discovery](../../skill-resources/references/input.md).
3. Treat each Node by its [type](../../skill-resources/references/node-types.md):
   work toward `goal`, follow `prompt`, and check `output` against its
   material before relying on it.

## After working: keep what later work needs

Before you deliver, update the Nodes your work actually affected:

- New confirmed intent, a rule, a decision, a result or a problem: update the
  Node that already owns that fact, or create one when none does.
- A fact your work made wrong: correct it.
- A new output: associate it with the confirmed goal it serves using
  `node link-output`, marking recorded, inferred or confirmed provenance.
- Changed material with a still-valid judgment: read the Node and material,
  then use `node confirm`. Keep intended but unfinished work `planned`.
- Changed judgment: correct the Node and confirm the reviewed basis, using
  `node write --confirm` or `confirm: true` in a write-many update to save both
  together. A plain save does not clear `behind`.
- Nothing changed: leave the Nodes as they are.

Saving observes new material versions automatically and preserves existing
bases until confirmation; do not calculate or enter hashes. `node check`
inspects synchronization; it does not decide what
is true. `workspace drift` finds unlinked outputs, changed output bases and
goals without outputs. Stop questions are prompts for this judgment, not
instructions to save every signal. Conversation-only decisions may remain
unanchored; do not invent file references to remove that state.

Write for the next reader, following
[Node saving](../../skill-resources/references/node-maintenance.md): open with
what the Node is and how to use it, state facts directly, and keep only the
caveats that change what a reader should do. Label unverified or pending items
as such.

Keep one Node per independently useful fact, not one per file, turn or tool
result. The parent expresses scope; share a fact by linking to its owner.
When material stays in the Workspace, link to it instead of retelling its
contents. Save what it does not say: which facts are current, withdrawn or
superseded, decisions and reasons, and effects across work directions. Keep
facts that change together in the same Node.

After maintaining Nodes, run `tent workspace check --json` once to find broken
links, invalid material addresses and missing material files; do not write a
checking script.

Keep `goal` and `prompt` focused on confirmed intent, agreements, decisions
and reasons, including who confirmed them and when if known. Keep commit
ids, test counts and merge or delivery status in Git and Card history;
preserve useful verification as dated `output` evidence. Card reception alone
does not prove completion.

Before replacing a Node body or raw document, read it with
`tent node get <node-id> --full --json` (add `--view raw` for raw editing).
Use that complete live text and its ETag. A partial page or a Card's pinned
source is not a basis for replacing the current Node.

Ordinary work needs neither a Role nor a Card. Use
[tent-role](../tent-role/SKILL.md) for a continuing work direction and
[tent-card](../tent-card/SKILL.md) for a recorded input.
