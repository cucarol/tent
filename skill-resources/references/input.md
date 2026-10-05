# Find and read Tent context

Pass `--workspace <root>` when your shell runs outside the Workspace.

## Find

Start from what you have and stop once you have what the task needs:

| You have | Run |
| --- | --- |
| Nothing specific | `tent workspace brief` |
| A Node id | `tent node get <node-id> --json` |
| A topic or term | `tent node search "<term>" --json` |
| A file | `tent node search --resource <path> --json` |
| A Node, and want its neighbours | `tent node relations <node-id> --direction <parent\|children\|outgoing\|incoming> --json` |
| The tree | `tent node list [--parent <node-id>] --json` |

Keep the `node-` ids you find; names and paths can change. A search hit can be
a passing mention, so read the Node before relying on it. Type, tags and
`description` help judge relevance first; see [Node types](node-types.md).

## Read

- Reads return content in `text`, one bounded page at a time. Continue with
  `--cursor <page.nextCursor> --expected-etag <etag>`; a partial page is not
  the whole document. `--full` reads all of it.
- `tent node read-many <node-id> <node-id> ... --json` reads several Nodes.
- `--view raw` includes the frontmatter.

## Versions

Whole-document reads return `version: {commit, path}`. With it,
`node get --version-json '<version>'` rereads those bytes,
`node diff --from-json <old> --to-json <new>` compares two versions,
`node history <node-id>` lists versions across moves, and
`workspace changes --from <commit> --to <commit>` lists what changed. A Card's
sources are pinned versions; keep them apart from live results.

## Material

`resource` and `sources` point at files, pages or images. Read them with your
usual tools when the task needs them; Tent stores the address, not the content.
A pointer does not mean the material was read or is still current.
