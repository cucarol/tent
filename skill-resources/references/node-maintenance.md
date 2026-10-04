# Save Nodes

Read the context you need first ([context discovery](input.md)) and use the
Workspace described in [runtime access](access.md).

## Decide what to save

Save what later work will need and cannot easily rebuild:

- confirmed intent and requirements (`goal`)
- specs, rules, decisions with their reasons, and useful references (`prompt`)
- produced artifacts, verification results, analyses and observed problems
  (`output`)

Choose the type with [Node types](node-types.md). Update the Node that already
owns a fact before creating another, and split a Node when part of it will be
read or revised on its own. Leave out one-off details, raw tool output and
anything the repository or its Git history already records.

When a material file stays in the Workspace, link to it instead of retelling
its contents. Record what the material does not say: current, withdrawn or
superseded status, decisions and reasons, and effects across work directions.
Keep facts that change together in the same Node so one change has one place
to maintain; do not create one Node per source file.

Keep `goal` and `prompt` to confirmed intent, agreements, decisions and their
reasons. Preserve who confirmed them and when if known; do not invent missing
attribution. Commit ids, test counts and merge or delivery status belong to
Git and Card history, not these Nodes. Move useful verification into dated
`output` evidence. A consumed Card records reception, not completion.

## Write the body

Write for an Agent or person who arrives without this conversation:

- Open with one or two sentences saying what this Node is and how to use it.
  Put the same summary in `description` when it helps discovery.
- State facts directly: what is true, what to do, what was decided. Add a
  limitation only when it changes what the reader should do.
- Label anything uncertain as unverified, pending or assumed.
- In `output` Nodes, name what you checked: the file or command, the version
  or commit, and the date.
- Link related Nodes instead of repeating them. Use ordinary Markdown links to
  the target's actual `.md` path relative to this document, taken from a live
  read, such as `[Topic](../<Topic>/<Topic>.md)`. You can also supply
  `[Topic](node-ID)`; saving converts a known Node id to a relative path.
- Use whatever Markdown structure fits; there is no required template.

## Create

```text
tent node create <name> --type <type> [--parent <node-id>] [--body -] [--resource <path>] [--sources-json <JSON>] [--tags a,b] [--planned] --json
```

The name becomes the folder and file name. Body, type, resource, sources and
tags are saved together, and only one argument can read stdin. If a create
fails unclearly, check whether the Node exists before retrying.

## Edit

Before replacing a body, read the complete live body with `--full`; use
`--view raw --full` before replacing the raw document. Never write a partial
page, summary, search excerpt or historical source as the whole document.
An incomplete CLI read marks its ETag as `read:<etag>`. Core rejects that
basis for body/raw replacement with `INCOMPLETE_READ`; reread with `--full`
and preserve the returned complete text. Do not strip the marker. The marked
basis remains usable for continuation and metadata-only edits.
Every edit needs the ETag from the live read that informed it:

Read responses put body or raw content in `text`, including `--full`; the
write input below uses `body` for the replacement.

```text
tent node get <node-id> --full --json
tent node write <node-id> --input-json - --json
```

```json
{"baseEtag":"<etag>","body":"<complete new body>","frontmatter":{"sources":[{"resource":"../../src/example.ts"}]},"readBack":true}
```

- Omitted body and fields stay unchanged, and unknown metadata is kept.
- Use top-level `planned: true` for intended but unfinished work, or
  `planned: false` to remove that explicit intent marker. It is independent
  of OKF lifecycle status and supported by batch inputs too.
- `sources` replaces the whole list: send every entry in order, and
  `sources: []` to clear it.
- For a body-only edit, use
  `tent node write <node-id> --body - --base-etag <etag> --read-back`.
- For type or tags, use `tent node type <node-id> <type> --base-etag <etag>`
  or `tent node tags set|add|remove <node-id> <tags> --base-etag <etag>`.
- `readBack` returns a page of the saved bytes with the new ETag. If it is
  partial, continue with `tent node get <node-id> --expected-etag <etag> --cursor <nextCursor>`.
- Pass Markdown and JSON through stdin; shell text pipes can add a trailing
  newline.

On an ETag conflict, someone changed the Node after you read it. Read it
again, look at what changed, merge your edit into the new text and save with
the new ETag. Do the same when you find edits made outside Tent. A Card's
pinned source is never an edit basis.

Single-Node saves return `version: {commit, path}`; unchanged bytes add no commit. If a
save reports that Git capture failed, the Markdown may already be written, so
read it before retrying.

## Write several Nodes

Use one batch instead of calling create or write in a loop:

```text
tent node write-many --input-json - --json
```

```json
{"items":[{"op":"create","ref":"export","parent":"@rules","name":"Export decision","type":"prompt","body":"The approved export decision depends on [Rules](@rules)."},{"op":"create","ref":"rules","name":"Rules","type":"prompt","body":"Decision and reasons; affects [Export](@export)."},{"op":"update","nodeId":"node-existing","baseEtag":"<complete live-read etag>","body":"Complete revised body."}]}
```

Each create has a unique `ref` (a letter followed by letters, digits, `_` or
`-`). `parent` is absent/null for the root, an existing Node id, or `@ref`.
Use `@ref` in Markdown link destinations or material addresses too; later
items may be referenced, but parents cannot form a cycle. Updates name
existing Nodes and require a complete live-read ETag, even for metadata-only
updates. Read the current complete body before changing an existing Node.

The batch is validated before saving and uses one lock and one Tent commit.
If an item fails, the batch is rolled back. Ordered `results` return each
`nodeId`, `path` and saved `etag`; keep these receipts instead of reading every
Node again. Inspect any reported rollback failure before retrying.

## Material paths

`resource` is the Node's main material; `sources` lists related material in
order, each as `{resource, ...metadata}`. Known Node ids in these fields are
also converted to relative paths on save. Compute relative paths from the
Node's own file: from `.tent/Area/Topic/Topic.md`, the Workspace file
`src/app.ts` is `../../../src/app.ts`. Use a leading `/` for paths from
`.tent/`, and a `file:` URI for anything outside the Workspace. Text that is
not an explicit path or URI is kept as a description. A missing file does not
block saving.

Create and write reject new or changed invalid addresses: `/../spec/x.md`
escapes `.tent`; from `.tent/A/B/B.md`, use `../../../spec/x.md` instead.

## Check a Node against its material

After maintaining Nodes, run `tent workspace check --json` once instead of
writing a checking script. It reports unresolved links, invalid material
addresses and missing local material files across Nodes, Roles and Cards.
It changes no files and does not decide whether a fact is still current.

Creating and saving automatically observe new local material versions. A plain
save retains existing versions when material changed or became unavailable;
it cannot clear `behind`, even when part of the body changed. Do not
enter hashes or edit generated `sync` and `outputs` metadata. An old Node
without a recorded version remains unanchored until saved or confirmed.
Remote sources and conversation-only decisions can remain unanchored.

```text
tent node check <node-id> --json
tent workspace brief
tent workspace drift --json
```

Check reports `synced`, `ahead`, `behind` or `unanchored`, plus the material
and output evidence. It is read-only and proves version agreement, not
correctness. All `goal` Nodes are requirements regardless of suffix. A saved
goal without an output or explicit implementation confirmation is ahead;
an explicit plan records the first known start time. Material changes or
changed output bases require review.

After reading the complete live Node and the changed material, choose:

- Judgment still holds: `tent node confirm <node-id> --base-etag <etag> --json`.
- Judgment changed: review the changed material and drifted outputs, then save
  the corrected Node with `node write --confirm` (or `confirm: true` in write
  JSON or a write-many update item), or follow the save with `node confirm`.
- Intent remains unfinished: write `planned: true`. Changed material still
  requires review and confirmation; a plan alone does not clear `behind`.
- Implementation is verified by declared local material but has no separate
  output: add `--implemented` to confirmation. This clears an explicit plan.

Confirmation records the current basis without rewriting the body. It does
not clear an explicit plan unless `--implemented` is supplied. Both commands
require an ETag from a complete live read; a summary or old Card is not an
edit basis. Material that still cannot be read retains its known old version
and remains behind even after confirmation.

## Associate an output with its requirement

Read the goal and use one command to record the association:

```text
tent node link-output <goal-id> --resource <path-or-node-id> --provenance inferred --base-etag <etag> --json
```

Use `recorded` for a linkage supported by observed records, `inferred` for
your reasoned attribution, and `confirmed` for an explicitly confirmed
association. Paths resolve from the requirement Node's Markdown; Node ids
are converted to relative paths. The command stores the output address and
current requirement/material basis in the goal and records the save in Git.
Requirement or material changes can make an associated output
`possiblyDrifted`; linking it again does not acknowledge that requirement
change. Review and confirm explicitly.

`workspace drift` reports unlinked outputs, changed output bases and goals
without output associations. Stop can suggest likely goals from this turn's
observed files, but never associates or confirms on your behalf. Treat a
possible intent signal as a question; save only a real confirmed requirement
or decision. Session observations contain addresses and versions, not file
or conversation contents.

## Structure and lifecycle

- `tent node rename <node-id> <name>` and
  `tent node move <node-id> --parent <node-id|root>` keep the id and update
  links and material paths in other Nodes and Roles.
- `status` is this document's lifecycle: `draft`, `stable` (the default when
  absent) or `deprecated`. It belongs to the document alone and is not
  inherited from the parent.
- `tent node archive <node-id>` marks a subtree deprecated and returns the
  commit. `tent node restore <node-id> --archive-commit <commit>` undoes it
  while those Nodes are unchanged since.
- `tent node delete <node-id>` permanently removes a whole subtree; use it
  only when the user asks. Move any children worth keeping first. Referenced
  materials are never deleted.

## Finish

Keep the saved results and run the whole-graph check once. A successful batch
returns the ordered identities and ETags for your complete inputs; do not
read every Node back just to confirm it was saved. Re-read when a save is
uncertain, another writer changed a Node, or you need to inspect content you
have not read. Titles, tags and wording should still match the facts.
Whoever integrates parallel changes checks the combined result.
