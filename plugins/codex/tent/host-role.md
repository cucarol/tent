# Working as a Role

`wake.mjs` sits beside the `cli.mjs` that the Tent CLI line of your session context names; run it with `node`. Started once, it binds this chat to the Role and keeps running after your turn: the Role's Cards and words other sessions send to the Role arrive here as messages.

| When | Do | Read |
| --- | --- | --- |
| Starting as a Role | `node <dir>/wake.mjs --role <role-id> --workspace <root>`; add `--include-open` to hear about public Cards too | `Bound` line, then any Cards already waiting; take the first |
| A message starting `Tent: Cards for` arrives | Take the first Card it names | `sources` |
| A message starting `Tent: a message for` arrives | Act on it; reply to the Role it names after `from` the same way, or in a Card | — |
| A quick word for another Role's chat | `node <dir>/wake.mjs --tell <role-id> --from <your-role-id> --workspace <root> --message -` with the text on stdin | `Told` line; if no chat is bound, send a Card |
| This chat stops working as the Role | The start command with `--stop` | `Unbound` line |
