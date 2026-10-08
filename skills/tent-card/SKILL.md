---
name: tent-card
description: "Sends, takes, moves, cancels and tracks Tent Cards. Use when work is handed to or from a Role, or a Card id comes up."
---

# Tent Card

Run `tent` as [access](../../skill-resources/references/access.md) shows; more commands in [cards](../../skill-resources/references/cards.md).

| When | Command | Read |
| --- | --- | --- |
| Hand work to a Role | Save the requirements as goal Nodes, then `tent card create` as below | `cardId` |
| Preview, or check handed-off work | `tent card show <card-id>` | `text`, `sources`; `state`, `progress`, `outputNodeIds` |
| Start on it | `tent card take <card-id> --role <role-id>` | `replayed` (`true`: continue that work), `sources` |
| `tent workspace brief` lists `changedCardSources` | `tent node get <node-id>` | current `text` |
| The result file is in the Workspace checkout | `tent node link-output <goal-id> --resource <path> --card <card-id>` | `cardId` |
| Idle as a Role, if the host wakes you after a background command | `tent card watch --role <role-id>` in the background | exit 0 prints Cards to take |

The receiver starts without this conversation; name the goal and let the sources carry the rest:

```text
printf 'Build the login goal.\n' | tent card create --prompt - --source node-abc123 --source docs/req.md --target role-xyz789
```

Change requirements in the Nodes; a published Card stays as sent.
