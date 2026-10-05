# Save Nodes

Exact arguments: `tent node --help`. Pass Markdown and JSON through stdin
(`-`) to keep newlines intact.

## What to save

Save what later work needs and cannot easily rebuild: confirmed intent
(`goal`); rules, decisions with their reasons and references (`prompt`);
results, verification and observed problems (`output`). See
[Node types](node-types.md). Update the Node that owns a fact before creating
another, and split out a part that will be read or revised on its own. Leave
out one-off details, raw tool output and what Git already records. Keep who
confirmed a decision and when, if known; never invent it.

## Write the body

Write for a reader without this conversation. Open with what the Node is and
how to use it, and repeat that in `description` when it helps search. State
facts directly and label anything unverified. In an `output`, name what you
checked and when. Link other Nodes with relative Markdown links, or with
`[Topic](node-ID)`, which saving converts to a path.

## Create

```text
tent node create <name> --type <type> [--parent <node-id>] [--body -] [--resource <path>] [--sources-json <JSON>] [--tags a,b] --json
```

The name becomes the folder and file name. If a create fails unclearly, check
whether the Node exists before retrying.

## Change part of a Node

- Append: `tent node append <id> --body - [--heading "Title"]`. It needs no
  read or ETag; with an existing heading, the text goes to the end of that
  section.
- One section: `tent node get-section <id> --heading "Title" --json`, then
  `tent node write-section <id> --heading "Title" --base-etag <sectionEtag> --body -`
  with the complete new section, heading included. Edits to other sections
  do not conflict.

Keep the returned ETag and version instead of reading the Node back.

## Replace a whole Node

Read the complete live document first with `tent node get <id> --full --json`
(add `--view raw` to include frontmatter). A paged or partial read returns a
`read:` ETag, which cannot replace a body. Then:

- body only: `tent node write <id> --body - --base-etag <etag>`;
- body and fields: `tent node write <id> --input-json -` with
  `{"baseEtag": "...", "body": "...", "frontmatter": {...}}`. Omitted fields
  stay, and `sources` replaces the whole list;
- type or tags: `tent node type` or `tent node tags set|add|remove`.

On an ETag conflict, read again, merge your change into the new text and save
with the new ETag. A Card's pinned source is never an edit basis.

## Several Nodes at once

`tent node write-many --input-json -` takes `{"items": [...]}`, with items such
as `{"op": "create", "ref": "rules", "parent": "@other", "name": "...", "type": "...", "body": "..."}`
and `{"op": "update", "nodeId": "...", "baseEtag": "...", "body": "..."}`.
`@ref` works in parents, links and material addresses. The batch saves in one
commit or not at all; keep its returned ids and ETags.

## Material addresses

`resource` is the main material; `sources` lists related material in order as
`{resource, ...}`. Paths are relative to the Node's own file: from
`.tent/Area/Topic/Topic.md`, the Workspace file `src/app.ts` is
`../../../src/app.ts`. A leading `/` starts at `.tent/`, and anything outside
the Workspace needs a `file:` URI. Point at the narrowest material that
supports the fact. After saving, run `tent workspace check --json` once to
find broken links and missing files.

## Behind, ahead and confirming

Tent records material versions in Git when you save; never enter hashes.
`tent node check <id>` and `tent workspace drift` report:

- **behind**: recorded material changed or is missing, `stale_after` passed,
  or an output's goal changed;
- **ahead**: a goal with no output in its subtree, or whose own outputs lag
  behind its latest change.

A goal can be both. Only confirmation clears behind. After reading the
complete Node and the changed material, run
`tent node confirm <id> --base-etag <etag>` if it still holds, or save the
correction with `node write --confirm`. Matching versions do not prove the
content right.

## Authorship

Content changes record `generated: {by, at}` and confirmation records
`verified: [{by, at}]`. The default actor is `tent/<version>`. Pass
`--by human:<id>` only for a person's actual review, and never guess a model
identity.

## Outputs

`tent node link-output <goal-id> --resource <path-or-node-id> [--name <name>]`
creates an `output` child named after the file. Paths resolve from the
Workspace root and the file must exist. An output belongs to its nearest goal
ancestor and counts for every goal above it, including Card progress. When a
goal changes, review its outputs and confirm them. Questions, research and
pending decisions are `prompt` Nodes: an `output` under a goal reads as
implemented.

## Structure and lifecycle

- `node rename` and `node move --parent <node-id|root>` keep the id and update
  links that point at the Node.
- `status` is `draft`, `stable` (the default) or `deprecated`, for this
  document only.
- `node archive` deprecates a subtree; `node restore --archive-commit <commit>`
  undoes it.
- `node delete` removes a subtree permanently; use it only when the user asks.
