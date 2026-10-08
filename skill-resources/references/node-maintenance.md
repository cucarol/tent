# Save Nodes

Exact arguments: `tent node --help`. Pass Markdown and JSON through stdin
(`-`) to keep newlines intact.

## What to save

Save what later work needs and cannot easily rebuild: confirmed intent
(`goal`); rules, decisions with their reasons and references (`prompt`);
results, verification and observed problems (`output`). Tags name the form
and topic; see [Node types and tags](node-types.md). Update the Node that
owns a fact before creating another, and split out a part that will be read
or revised on its own. Leave out one-off details, raw tool output and what
Git already records. Keep who confirmed a decision and when, if known; never
invent it.

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

The type is `goal`, `prompt` or `output`. Take tags from `tent node tags`
(tags in use, with counts) or the presets before inventing one. The name
becomes the folder and file name. If a create fails unclearly, check whether
the Node exists before retrying.

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
`{resource, ...}`. CLI arguments and stored documents use different anchors:

- **CLI arguments** (`--resource`, `--sources-json`, `link-output --resource`,
  `card create --source`, frontmatter in `node write --input-json` and
  write-many) resolve from the Workspace root: `src/app.ts`, `./src/app.ts`
  and `/src/app.ts` all name the Workspace file `src/app.ts`, and
  `.tent/Area/Topic/Topic.md` names a Node file. A Node id also works. A bare
  source that matches no file stays a description; use `./` for a file that
  does not exist yet. Anything outside the Workspace needs a `file:` URI.
- **Stored documents** hold addresses relative to the declaring file, and
  Tent rewrites CLI paths into that form on save: from
  `.tent/Area/Topic/Topic.md`, `src/app.ts` is stored as
  `../../../src/app.ts`, and a stored leading `/` starts at `.tent/`. Write
  this form yourself only in raw Markdown edits and body links.

Point at the narrowest material that supports the fact. A `goal` or `prompt`
does not take code files under `src/` as materials: its materials are the
grounds for the intent, while code is the current state. To mention an
implementation file, link it in the body; to track one, put it in the
`resource` of an output. After saving, run `tent workspace check --json` once
to find broken links and missing files.

For large documents, reference the relevant section or sections instead of
the whole file unless the fact genuinely depends on the entire document.

For a Markdown material, add the heading as a fragment, such as
`--resource docs/design.md#State`, to track only that section (including its
heading and subsections). Use the heading text from
`node get-section --heading`; percent-encoded text works too. Editing another
section leaves this material current. A missing or duplicated heading makes
it unavailable and is reported by `workspace check`. Without a fragment, or
for a non-Markdown file, the whole file is tracked. Card sources still pin the
complete Node version.

## Behind, ahead and confirming

Tent records material versions in Git when you save; never enter hashes.
`tent node check <id>` and `tent workspace drift` report:

- **behind**: recorded material changed or is missing, `stale_after` passed,
  or any ancestor goal's content or material changed relative to the output;
- **ahead**: a goal with no active output in its subtree, or whose outputs
  lag behind that goal's content or materials. Tags do not change this.

A goal can be both. After reading the
complete Node and the changed material, run
`tent node confirm <id> --base-etag <etag>` if it still holds, or save the
correction with `node write --confirm`. Rewriting an output's complete body
also refreshes its dependencies; appending, section edits and metadata
changes retain them. Confirming a goal never confirms its outputs.
Matching versions do not prove the content right.

## Authorship

Content changes record `generated: {by, at}` and confirmation records
`verified: [{by, at}]`. The default actor is `tent/<version>`. Pass
`--by human:<id>` only for a person's actual review, and never guess a model
identity.

## Outputs

`tent node link-output <goal-id> --resource <path-or-node-id> [--name <name>] [--role <id>] [--card <id>]`
creates an `output` child named after the file; it gets only the tags you
pass with `--tags a,b`, such as `asset` or `evidence`. Paths resolve from the
Workspace root and the file must exist. Link a result only once it is in
that checkout. Tracked materials retain a repository-relative location and
can still be observed from a surviving checkout after worktree removal.
An output depends on every goal ancestor. For Card progress, its sources
must name the Card it answers; pass `--card <id>`, or `--role <id>` to infer
a unique incomplete Card received by that Role. An explicit Card may cross
Roles, but must be received, not deprecated, and reference a goal on this
output's ancestor chain. When a
goal changes, review its outputs and confirm them. Questions, research and
pending decisions are `prompt` Nodes. Every current output counts for its
goals and the Card it names, whatever its tags, including an `issue`.

## Structure and lifecycle

- `node rename` and `node move --parent <node-id|root>` keep the id and update
  links that point at the Node.
- Node names follow Windows file-name rules on every platform: no
  `< > : " / \ | ? *`, C0 control character (tab, CR, LF included), DEL,
  U+2028 or U+2029, no trailing dot, and not `CON`, `PRN`, `AUX`, `NUL`,
  `COM1`–`COM9`, `LPT1`–`LPT9`, `COM¹`–`COM³` or `LPT¹`–`LPT³` in any case,
  with or without an extension; surrounding whitespace is trimmed.
- `status` is `draft`, `stable` (the default) or `deprecated`, for this
  document only.
- `node archive` deprecates a subtree; `node restore --archive-commit <commit>`
  undoes it.
- `node delete` removes a subtree permanently; use it only when the user asks.
