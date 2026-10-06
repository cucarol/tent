# Card commands

```text
tent card create --prompt - --source <node-id|path|JSON> ... [--target <role-id>] [--title <text>]
tent card list [--role <role-id> [--include-open]] [--state pending|consumed] [--include-deprecated]
tent card show <card-id> [--view raw]
tent card take <card-id> [--role <role-id>]
tent card move <card-id> (--to <role-id> | --public) --base-etag <etag>
tent card deprecate <card-id> --base-etag <etag>
tent card watch --role <role-id> [--timeout <seconds>]
```

All commands accept `--workspace` and `--json`.

`watch` checks committed pending Cards for exactly that Role, excluding
deprecated Cards, without writing files or history. It checks HEAD every three
seconds while idle. Omit the timeout to wait indefinitely; `0` checks once.
Exit 0 prints each Card's id, title and take command on one line (a JSON array
with `--json`); exit 2 means timeout with no output; exit 1 means error.

## Sources

Repeat `--source` in reading order. Each is a Node id, a Workspace-root
file path or a JSON `{"resource": ...}` using the same rules. For example,
`--source docs/req.md`, `--source ./docs/req.md` and `--source /docs/req.md`
all name the Workspace file `docs/req.md`, regardless of the shell's current
directory. Use `--source node-ID` for a Node, or its Workspace path such as
`.tent/Area/Topic/Topic.md`. Absolute external paths use a `file:` URI;
remote URIs remain addresses. Nodes and Roles are pinned to their selected
version; other addresses stay addresses. Stored Card paths are relative to
the Card document, after CLI conversion.

## Reception and progress

`pending` means not yet received and `consumed` means received. A targeted
Card needs its Role to take it; a public Card can be taken with or without
one, and `--include-open` adds public Cards to a Role's list.

Progress follows the goals among a Card's sources: `pending`,
`received-no-output`, `needs-review`, or `has-output` once each goal's subtree
has a current `output-asset` or `output-evidence` whose sources name this
Card. Behind responses count as awaiting review, not completed work.
`goalCount` and `totalGoalCount` count completed and requested goals.
Use `node link-output --card <id>`; automatic inference requires `--role`
matching the receiver of exactly one incomplete Card for the goal. Missing
or mismatched Roles require an explicit Card when relevant Cards exist.
An explicit Card may cross Roles, but must be received, not deprecated, and
have a goal source on the new output's goal chain.
The receipt includes the selected `cardId`. A Card without
goal sources shows reception only. Confirming an unrelated output never
completes a Card. Completion times come from output generated/verified times.

## Move and cancel

A pending Card can move to another Role or to the public area, using the ETag
from `show`; after reception its destination is fixed. `deprecate` cancels a
task and keeps its input. Lists hide deprecated Cards unless
`--include-deprecated`, and `show` or `take` warn about them.

## Read

`show` and `take` return one page; continue with `page.next`. Read a pinned
source with
`tent node get <node-id> --version-json '{"commit": "...", "path": "..."}' --json`.
The brief reports a received Card's source that changed while its goal is
still ahead; read the current Node then.

Published prompt, title and sources never change, and hand edits are reported
as `INPUT_CHANGED`. Put requirement changes in the Nodes.
