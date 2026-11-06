---
name: tent-role
description: "Works as a Tent Role or sets one up, and sends, takes, returns and tracks Cards between Roles. A Role is the standing brief for one kind of session, like an AGENTS.md for it; a Card hands one task to a Role. Use when told to work as a Role, when work is handed to or from a Role, or when a Card id comes up."
---

# Tent Role

A Role is one Markdown file at `.tent/roles/<role-id>.md`; read and edit it with your own tools. Run `tent` as [access](../../skill-resources/references/access.md) shows.

## Roles

| When | Do | Read |
| --- | --- | --- |
| Given a Role name | Look through `.tent/roles/` | each file's `title`; skip `status: deprecated` |
| Starting as a Role | Read its file, then [this host's steps](references/host-role.md) | the body, then the Nodes it links |
| Looking for work | `tent card list --role <role-id>` | what waits, in order |
| A new direction | `tent role create --title <title> --body -` | `roleId` |
| Retire or remove | [Role commands](../../skill-resources/references/roles.md) | — |

A Role body holds purpose, boundaries, methods and Node links; shared facts live in Nodes. Decide inside those boundaries; send a Card to the Role that owns any other decision.

## Cards

More in [cards](../../skill-resources/references/cards.md).

| When | Command | Read |
| --- | --- | --- |
| Hand work to a Role | `tent card create`, as below | `cardId` |
| Start on a Card | `tent card take <card-id> --role <role-id>` | the task, then each source's name and path; read the sources with your own tools. `replayed: true` means continue that work |
| Done with a Card that has `returnTo` | `tent card return <card-id> --role <role-id> --result '<one line>'` | `state: returned` |
| A Card you sent is `returned` | `tent card take <card-id> --role <role-id>` | `result`; the Card is `closed` |
| Idle as a Role | Wait as [your host does](references/host-role.md) | the Cards it names; take the first |

Write the task in the Card: the receiver starts without this conversation. Point `--source` at the Nodes and files it needs, as a Node id, a Node section such as `node-abc123#Heading`, or a Workspace-root path. Add `--return-to` with your own Role when you want to hear back.

```text
printf 'Add sign-in with email codes. Keep the rules in the source Node.
' | tent card create --prompt - --title 'Email sign-in' --source node-abc123 --source docs/req.md --target role-xyz789 --return-to role-abc456
```

Send every task already decided now, one Card per task, in the order it should run; the receiver works through its queue without waiting for you.

A return is one line of at most 200 characters: the outcome, the commits, and where the details are. Report progress and completion this way, not with a new Card; send a Card only when the other Role has something to do.

A Card carries work that needs its sources and a return, or reaches a session your host's own messaging cannot. A quick question or answer to a session that messaging reaches goes through it instead.

A sent Card never changes. When the task changes before the Card is taken, cancel it and send a new one; after it is taken, tell the receiver through your host's messaging or a new Card.
