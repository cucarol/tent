---
name: tent-card
description: "Send, receive, transfer or cancel a Tent Card; check its reception and outputs."
---

# Tent Card

| When | Run / do | Check |
| --- | --- | --- |
| Send work | Save requirements in [Nodes](../tent-node/SKILL.md), one goal per result; `tent card create --prompt - --source <goal-id> --target <role-id>` | Use a short prompt; repeat `--source` as needed; omit target for public work |
| Preview | `tent card show <card-id> --json` | Read `text`, `sources`, warnings; continue `page.next` |
| Start | `tent card take <card-id> --role <role-id> --json` | `replayed: true`: continue existing work; read sources |
| Source changed | `tent node get <node-id>` | Read the current Node named in brief |
| Record result | `tent node link-output <goal-id> --resource <path> --card <card-id>` | File must be in the Workspace checkout; check returned `cardId` |
| Check work | `tent card show <card-id> --json` | `consumed` means received; inspect `progress` and actual outputs |
| Move / cancel | Use [Card commands](../../skill-resources/references/cards.md) | Read latest `etag` first |

File paths use the Workspace root. Change requirements in Nodes, never in the published Card. Keep undecided requirements in draft Nodes. No reply Card is needed for results.

## Wait

If the host can wake you after a background command, run `tent card watch --role <role-id>`. Take or move returned Cards, then wait again. For an authorized scheduled check use `--timeout 0`; ask before creating a lasting schedule. If the host stops the wait, report it without repeated restarts. Otherwise check pending Cards when a session starts.

Maintainer background: [plugin guide](../../docs/PLUGIN.md).
