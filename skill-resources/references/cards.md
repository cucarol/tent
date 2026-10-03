# Card commands

```text
tent card create --prompt - --source node-ID --target role-ID [--title TEXT]
tent card list [--role role-ID [--include-open]] [--state pending|consumed|interrupted] [--include-drafts]
tent card show card-ID
tent card show card-ID --view raw
tent card take card-ID [--role role-ID]
tent card move card-ID (--to role-ID | --public) --base-etag HASH
tent card interrupt card-ID [--role role-ID] --commit COMMIT
tent card continue card-ID [--role role-ID] --commit COMMIT
```

All commands accept `--workspace`.

## Sources

Each `--source` is a Node id, a path or a JSON object `{"resource": ..., ...metadata}`.
Repeat the flag for more sources, in the order the receiver should read them.
Paths resolve from the Card document in `.tent/cards/`; a leading `/` starts at
`.tent/`, so `/Topic/Topic.md` names the Node `Topic`. Selected Nodes and Roles
are pinned to their current Git version when the Card is created. Files outside
`.tent/`, URIs and plain descriptions stay addresses; their content is not
copied.

`--include-open` adds pending Cards that have no target to a Role's list.

## Status

Without `--role`, `list` returns published Cards with their `state`, `target` and
`receivedBy`; `show` returns the same fields for one Card. Any Role can read
them. `pending` has not been received, `consumed` has been received and
`interrupted` was paused by its receiver. No state says the requested work is
finished: check the result itself, and check again rather than repeating an
earlier reading.

Unpublished workspace drafts are excluded by default. `--include-drafts` includes
them with `draft: true` and `publishedAt: null`; a `--state` query always excludes
drafts. Reading a draft never publishes it, and `take` returns `UNPUBLISHED`.

A published pending Card can move between available Roles and the public area.
Use `move` with the observed ETag from `show`; each changed target enters Git
history. `--public` clears the target. After reception, including interruption,
the target is fixed. A move racing with reception can return a conflict; reread
the Card before deciding what to do next.

## Read a Card

`show` and `take` return one page of the prompt, the sources and the Card's
version. When `page.next` is present, continue with its view, range (`--start`,
`--end`) and `--expected-etag`. If `sourcesOmitted` is true, read the sources
with `--view raw`.

Read a pinned source as it was when the Card was created:

```text
git -C <workspace>/.tent show <commit>:<path>
tent node get <node-id> --version-json '{"commit":"<commit>","path":"<path>"}' --view raw --json
```

Opening the current file instead shows its live state, which may have changed
since.

## Reception

- `take` records reception and returns the input. A targeted Card needs its
  Role; an untargeted Card can be taken with or without one. Use the same
  choice for later `interrupt` and `continue`.
- `replayed: true` means reception was already recorded: continue that work
  rather than repeating it.
- `interrupt` and `continue` need `--commit` set to the `version.commit` you
  last observed, so a stale command cannot undo a newer change.
- A finished Card stays `consumed`; there is no completion record to write.
- Automatic interruption is not available yet; use the explicit commands.

## Hand edits and hand-written Cards

A published Card's input (prompt, title, sources and unknown fields) is fixed.
If someone edited it by hand, Card commands report `INPUT_CHANGED`: keep that
file as it is and create a new Card for the changed request. Editing `state`
or `target` by hand does not record a reception or a move. After a save error, inspect the Card before
retrying, because the file and its Git history are not updated atomically.

Publish a hand-written v3 Card with `tent card publish card-ID --base-etag HASH`.
