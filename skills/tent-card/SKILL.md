---
name: tent-card
description: "Record a prompt and its context references as a Tent Card, receive or transfer it, cancel a task, or check its reception and outputs."
---

# Tent Card

A Card is a short, fixed instruction pointing to the Nodes that hold the
requirements, optionally addressed to a Role. Commands:
[Card reference](../../skill-resources/references/cards.md).

## Send

1. Write the requirements, expected result and decisions in Nodes, one goal
   per requested result. The receiver starts without this conversation.
2. Create the Card with one or two sentences pointing at those goals:
   `tent card create --prompt - --source <node-id> ... --target <role-id>`.
3. When requirements change, edit the Nodes, not the Card; the receiver is
   told its source changed. Keep undecided requirements in Nodes with
   `status: draft` until ready, and cancel a task with `tent card deprecate`.

## Receive

1. Preview with `tent card show <card-id>`; previewing does not receive it.
2. Run `tent card take <card-id> [--role <role-id>]` when you start. Taking
   means received, not done; `replayed: true` means continue existing work.
3. Read its sources, and read the current Node when the brief says a source
   changed.
4. Record each result under its goal with `tent node link-output`. The Card's
   progress follows those goals, so no reply Card is needed.

## Wait for Cards

When you work as a Role and your host can run a command in the background and
wake you when it ends, or schedule a recurring check, arrange it yourself:
`tent card watch --role <role-id>` exits once the Role has a pending Card;
use `--timeout 0` in a scheduled check. Ask the user before creating a lasting
schedule. After waking, take or move the Card, then wait again. If the host
stops the wait, tell the user instead of restarting it repeatedly. Without
such a host feature, check the brief's pending Cards when a session starts.

## Check

Look now rather than from memory: `tent card show` and `tent card list` give
state, receiver and progress. A finished Card stays `consumed`; check the
actual result before calling it done. A pending Card can change Role with
`card move`.
