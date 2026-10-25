---
name: tent-card
description: "Sends, takes, returns, moves, cancels and tracks Tent Cards. Use when work is handed to or from a Role, or a Card id comes up."
---

# Tent Card

Run `tent` as [access](../../skill-resources/references/access.md) shows; more commands in [cards](../../skill-resources/references/cards.md).

| When | Command | Read |
| --- | --- | --- |
| Hand work to a Role | Save the requirements as goal Nodes, then `tent card create` as below | `cardId` |
| Preview, or check handed-off work | `tent card show <card-id>` | `text`, `sources`; `state`, `result` |
| Start on it | `tent card take <card-id> --role <role-id>` | `replayed` (`true`: continue that work), `sources` |
| `tent workspace brief` lists `changedCardSources` | Read each source's `path` | the current file |
| The result file is in the Workspace checkout | `tent node link-output <goal-id> --resource <path> --card <card-id>` | `cardId` |
| Done with a Card that has `returnTo` | `tent card return <card-id> --role <role-id> --result '<one line>'` | `state: returned` |
| A Card you sent is `returned` | `tent card take <card-id> --role <role-id>` | `result`; the Card is `closed` |
| Idle as a Role, if the host wakes you after a background command | `tent card watch --role <role-id>` in the background; add `--include-open` to see public Cards too | exit 0 prints Cards in queue order and returns to collect; take the first Card |

The receiver starts without this conversation; name the goal and let the sources carry the rest. Add `--return-to` with your own Role when you want to hear back:

```text
printf 'Build the login goal.\n' | tent card create --prompt - --source node-abc123 --source docs/req.md --target role-xyz789 --return-to role-abc456
```

Send every task already decided now, one Card per task, in the order it should run; the receiver works through its queue without waiting for you. When no Role is clearly the receiver, leave out `--target`: the Card waits in the public area, where any Role may claim it.

A return is one line of at most 200 characters: the outcome and the Node ids that hold the details. Report progress and completion this way, not with a new Card; send a Card only when the other Role has something to do.

Change requirements in the Nodes; a published Card stays as sent. A Node edit wakes no one: when it gives another Role something to do now, such as a new candidate to check, send that Role a Card naming the Node.
