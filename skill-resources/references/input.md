# Read Tent context

Use the existing Workspace, and pass `--workspace <root>` when your shell runs
elsewhere.

## Find the Nodes the task needs

Start from what you have and widen only as needed:

| You have | Run |
| --- | --- |
| A Node id | `tent node get <node-id> --view body --json` |
| A topic or term | `tent node search "<term>" --json` |
| A file, and want the Nodes about it | `tent node search --resource <path-from-.tent-or-URI> --json` |
| Nothing yet | `tent node list --json`, then `tent node list --parent <node-id> --json` |
| A Node, and want its neighbours | `tent node relations <node-id> --direction <parent\|children\|outgoing\|incoming> --json` |

These are alternatives, not a checklist; stop once you have what the task
needs. Keep the `node-` ids you find, because names and paths can change.

- `list` shows direct children only, of the root by default.
- `search` matches words in the body, name, path, type, tags and material
  addresses. A hit can be a passing mention, so read the Node before relying
  on it. Archived Nodes appear only with `--include-archived`.
- Parent and children come from folders; outgoing and incoming relations come
  from links and material declarations. Two Nodes are related only when one
  of these says so.
- Type and tags help judge relevance before reading a body; see
  [Node types](node-types.md). A `description` in the frontmatter states a
  Node's scope.

## Read bodies

All body/raw reads use `text`: `node get` (paged or `--full`), `read-many`
items, `role show` and `card show`. The view changes the contents, not the field
name. There is no `body` alias in read responses.

- `tent node get <node-id> --view body` returns one page of the body;
  `--view raw` includes the frontmatter.
- Read several Nodes in one call with `tent node read-many <node-id> <node-id> ... --json`;
  continue a long batch with `--start <page.nextIndex>`.
- Pages are bounded. When `page.nextCursor` is present, continue with
  `--cursor`, the same view and `--expected-etag`. A partial page is not the
  whole document.
- Before editing, read the complete live document and its ETag with
  `tent node get <node-id> --full --json`.

## Versions

Body and raw reads return `version: {commit, path}`: the exact bytes you read,
as kept in `.tent/.git`. Use it to:

- read those bytes again after later edits, renames or deletion:
  `tent node get <node-id> --version-json '<version>' --view raw --json`
- compare two versions, including path changes:
  `tent node diff --from-json '<old version>' --to-json '<new version>' --json`
- find retained versions across moves and deletion:
  `tent node history <node-id> --json`
- inspect changes between commits (from exclusive, to inclusive):
  `tent workspace changes --from <commit> --to <commit> --json`

Listing and search do not record versions. A Card's sources are pinned
versions: read them at that version, and keep them apart from live results.

## Referenced material

`resource` and `sources` point at real files, pages or images. Read them with
your usual tools when the task needs them; see [material reading](materials.md).
A pointer tells you where to look. It does not mean the material has been read
or is still current.
