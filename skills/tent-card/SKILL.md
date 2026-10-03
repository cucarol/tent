---
name: tent-card
description: "Record a prompt and its context references as a Tent Card for a Role or a later conversation, or preview, receive, interrupt and continue a Card, or check whether a Card has been received."
---

# Tent Card

A Card is one recorded input: a prompt with ordered references, optionally
addressed to a Role. Published input stays fixed; its destination can move
until reception. Use the
[bundled CLI](../../skill-resources/references/access.md) and
[Card commands](../../skill-resources/references/cards.md).

## Record an input

When the user asks to hand work to a Role or save a request for later:

1. Write a prompt that stands alone: the request, the expected result and
   anything already decided. The receiver starts without this conversation.
2. Add the Nodes, Roles and files the receiver should read as sources, most
   important first. Selected Nodes and Roles are pinned at their current
   version.
3. Address it with `--target <role-id>` when the work belongs to a Role.

Creating a Card does not start another Agent; the receiver takes it later.
To change a published request, create a new Card.

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
3. Read its sources at their pinned versions.
4. To pause, `interrupt` it; to resume, `continue` it. Both take the Card
   version you last observed and the same Role choice as the take.

`replayed: true` from take means the Card was already received: continue the
existing work instead of starting it again. A finished Card stays `consumed`.
Reply normally, and keep lasting facts in [Nodes](../tent-node/SKILL.md).
