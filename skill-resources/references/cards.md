# Card commands

```text
tent card create --prompt - --source node-ID --target role-ID [--title TEXT]
tent card list [--role role-ID [--include-open]] [--state pending|consumed] [--include-deprecated]
tent card show card-ID [--view raw]
tent card take card-ID [--role role-ID]
tent card move card-ID (--to role-ID | --public) --base-etag HASH
tent card deprecate card-ID --base-etag HASH
```

All commands accept `--workspace` and `--json`.

Keep concrete requirements and decisions in Nodes. A Card needs one or two
sentences directing the receiver to those Nodes. Creation publishes it
immediately. Keep undecided requirements in Nodes with `status: draft`; edit
those Nodes when requirements change.

## Sources

Each `--source` is a Node id, a path or a JSON object `{"resource": ..., ...metadata}`.
Repeat it in reading order. Paths resolve from `.tent/cards/`; `/` starts at
`.tent/`. Selected Nodes and Roles are pinned to their current Git version.
Files outside `.tent/`, URIs and descriptions remain addresses, without copying
their content.

## Reception and progress

Any Role can read a Card. `pending` means it has not been received; `consumed`
means it has. A targeted Card needs its Role for `take`; a public Card can be
taken with or without a Role. That reception choice cannot change later.
`--include-open` adds public pending Cards to a Role's list.

`replayed: true` means reception was already recorded. Continue the existing
work instead of repeating it. Finished Cards stay consumed.

Progress follows goals referenced in the Card's `sources`: `pending`,
`received-no-output`, or `has-output` when every referenced goal has an output
added or confirmed after publication. `goalCount` and `totalGoalCount` report
completed and total goals; `outputNodeIds` identifies results. Cards without
goal sources have `progress: null` and show reception only.

Use `node link-output` under the goal. This existing hierarchy supplies the
relationship; outputs need no Card source, extra flag or host context. Check
the actual result and its current goal basis before claiming completion.

## Transfer or cancel

A published pending Card can move between available Roles and the public area.
Use the observed ETag from `show`; `--public` clears the target. Each changed
target enters Git history. After reception the destination is fixed. If a
move races with reception, reread the Card before deciding what to do next.

`deprecate` cancels a task by setting lifecycle `status: deprecated`, preserving
its input, target and reception. It requires the ETag from `show`; stale tokens
or hand-edited management fields conflict. Repeating with the current ETag
makes no change.

Lists and briefs omit deprecated Cards by default. `--include-deprecated`
includes them with the usual filters. `show` and `take` retain their original
input with a cancellation notice and current references; review the notice
before acting. Deprecation does not relax the target Role requirement.

## Read a Card

`show` and `take` return a prompt page, sources and the Card's version. When
`page.next` exists, continue with its view, `--start`, `--end` and
`--expected-etag`. If `sourcesOmitted` is true, read with `--view raw`.

Read a source at its pinned version:

```text
git -C <workspace>/.tent show <commit>:<path>
tent node get <node-id> --version-json '{"commit":"<commit>","path":"<path>"}' --view raw --json
```

The brief reports changed sources of received Cards while their goal is still
ahead. With an
active Role it checks that Role's receptions; otherwise it checks the workspace.
It compares pinned bytes with the current Node by stable identity, including
edits not yet captured in history. Read the current requirements when warned,
and inspect missing-source diagnostics before proceeding.

## Hand edits

Published prompt, title, sources and unknown metadata are fixed. Hand-edited
input produces `INPUT_CHANGED`: inspect the diff, restore the published input,
and put requirement changes in its Nodes. Hand-editing `state`, `receivedBy`,
`target` or `status` does not record a management operation. After a save error,
inspect before retrying because file and Git writes are not atomic. Create
Cards through `card create`; there is no separate handwritten publication.
