---
name: tent-card
description: "Record a prompt and its context references as a Tent Card, receive or transfer it, cancel a task, or check its reception and outputs."
---

# Tent Card

A Card records a short task instruction pointing to the Nodes that hold its
requirements, optionally addressed to a Role. Published input stays fixed;
its destination can move until reception. Use the
[bundled CLI](../../skill-resources/references/access.md) and
[Card commands](../../skill-resources/references/cards.md).

## Record an input

When the user asks to hand work to a Role or save a request for later:

1. Write the concrete requirements, expected result and decisions in Nodes.
   The receiver starts without this conversation, so those Nodes must contain
   the context needed to act.
2. Keep the Card prompt to one or two sentences directing the receiver to
   those Nodes, and add them as sources in reading order. Selected Nodes and
   Roles are pinned at their current version.
3. Address it with `--target <role-id>` when the work belongs to a Role.

Creating a Card does not start another Agent; the receiver takes it later.
Keep undecided requests in Nodes with `status: draft`; create a Card when ready
for reception. When requirements change, edit their Nodes. Cancel a published
task with `tent card deprecate <card-id> --base-etag <observed-etag>`; its
input and reception record remain intact.

## Check on a Card

Every Role can read every Card's state; only the addressed Role can take a
targeted Card.

1. Before saying whether a Card has been received, look now:
   `tent card show <card-id>` or `tent card list` gives its `state` and
   `receivedBy`. A status noted earlier in the conversation may be out of date.
2. `consumed` only means the Card was received. To say the requested work is
   done, check its result, such as the change on the target branch or the
   updated Node. Compare content rather than commit ids, since the receiver
   may have rebased or re-applied a commit.

## Receive an input

1. Preview with `tent card show <card-id>`. Previewing does not receive it.
2. When you start acting on it, run `tent card take <card-id>`, adding
   `--role <role-id>` for a targeted Card. Take returns the input.
3. Read its sources at their pinned versions. Check the brief's received Card
   source-change reminders, then read the current Node when a source has
   changed. A missing source or diagnostic needs inspection before relying
   on the old requirements.
4. Save implementation results as output Nodes under the goals referenced by
   the Card, using `node link-output`. Questions, research and pending decisions
   belong in prompt Nodes; they do not count as implementation outputs.

`replayed: true` from take means the Card was already received: continue the
existing work instead of starting it again. A finished Card stays `consumed`.
Deprecated Cards are hidden from normal lists. `--include-deprecated` reveals
them; `show` and `take` retain their original input and warn that the task was
cancelled, with current documents that still refer to it. Review that notice
before acting.
Reply normally, and keep lasting facts in [Nodes](../tent-node/SKILL.md).

Progress follows the referenced goals: pending, received without all outputs,
or has outputs for every goal. Only outputs added or confirmed after publication
count; multiple goals show a completed/total count. Cards with no goal sources
show reception only. Check each output's current goal basis and actual result.
A pending Card can be transferred
with `card move`; its destination is fixed after reception.
