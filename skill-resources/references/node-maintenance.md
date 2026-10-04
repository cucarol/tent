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
tent node create <name> --type <type> [--parent <node-id>] [--body -] [--resource <path>] [--sources-json <JSON>] [--tags a,b] --json
```

The name becomes the folder and file name. Body, type, resource, sources and
tags are saved together, and only one argument can read stdin. If a create
fails unclearly, check whether the Node exists before retrying.

## Append or replace one section

Append with one command. No preceding full read or ETag is required:

```text
tent node append <node-id> --body - [--heading "Decision"] --json
```

The optional heading is plain text. If it already exists, Tent appends at the
end of that section; otherwise it adds a level-two Markdown heading. Repeated
matching headings are an error. Tent appends under the Workspace lock,
normalizes trailing newlines and separates the addition with a blank line.
CLI writes wait briefly for a busy lock; a timeout reports that it remains
busy. Successful appends retain earlier additions. The result includes the saved document's
canonical ETag and Git version; keep the receipt instead of reading back the
entire Node. Ordinary address and synchronization rules still apply: an
append does not confirm changed material or clear `behind`.

For a change within one section, read only that section:

```text
tent node get-section <node-id> --heading "Decision" --json
tent node write-section <node-id> --heading "Decision" --base-etag <sectionEtag> --body - --json
```

A section starts at its heading and ends before the next heading of the same
or higher level. Nested headings belong to it; headings in code blocks do
not count. Titles must identify exactly one heading. A missing or repeated
title is an error.

The read returns complete section `text`, including the heading, and its
`sectionEtag`, without capturing a whole-document Git version. Saving captures
the final document. Supply the complete replacement section as `--body`, including
the heading if it should remain. It may change or remove that heading. The
section ETag checks this section's bytes; edits to other sections do not
conflict. Changes to the selected section require rereading and reconciling
it. Other sections stay unchanged; Tent adds a missing separator before the
next heading within the replacement range. A section ETag is not a
full-document editing basis.

## Replace a whole document

Before replacing a body, read the complete live body with `--full`; use
`--view raw --full` before replacing the raw document. Never write a partial
page, summary, search excerpt or historical source as the whole document.
An incomplete CLI read marks its ETag as `read:<etag>`. Core rejects that
basis for body/raw replacement with `INCOMPLETE_READ`; reread with `--full`
and preserve the returned complete text. Do not strip the marker. The marked
basis remains usable for continuation and metadata-only edits.
Whole-body and raw replacements need the ETag from the live read that informed them:

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
enter hashes. Material and goal bases live in Git by Node ID, outside the
Markdown. An old Node without a recorded version remains unanchored until
saved or confirmed.
Remote sources and conversation-only decisions can remain unanchored.

```text
tent node check <node-id> --json
tent workspace brief
tent workspace drift --json
```

Check reports independent `ahead` and `behind` findings, plus neutral details,
material and output evidence. A goal can be both ahead and behind. It is
read-only and proves version agreement, not
correctness. All `goal` Nodes are requirements regardless of suffix. A saved
goal with no output anywhere in its subtree is ahead. Each output implicitly
depends on its nearest goal ancestor. A changed goal makes its own outputs
behind and keeps the goal ahead until those outputs are reviewed and
confirmed. Generation timestamps do not substitute for goal versions.

After reading the complete live Node and the changed material, choose:

- Judgment still holds: `tent node confirm <node-id> --base-etag <etag> --json`.
- Judgment changed: review the changed material and drifted outputs, then save
  the corrected Node with `node write --confirm` (or `confirm: true` in write
  JSON or a write-many update item), or follow the save with `node confirm`.

Confirmation records the current material and implicit goal basis without
rewriting the body. Both commands require an ETag from a complete live read; a summary or old Card is not an
edit basis. Material that still cannot be read retains its known old version
and remains behind even after confirmation.

## Record authorship and review

Content changes record OKF `generated: {by, at}`. Confirmation records
`verified: [{by, at}]`, retaining one latest timestamp per actor, without
rewriting the body or generation record. An edit preserves earlier reviews;
review history and content authorship answer different questions.

Use `--by human:<id>`, `--by process:<id>` or `--by <producer>/<version>`
when the actual actor is known; write JSON and batch items take `by`.
Otherwise the command records its actual `tent/<version>` runtime. Never
guess a model identity or claim a human review for an Agent confirmation.
Only `human:` verification is human-reviewed; other verifiers are
machine-confirmed. No verification means unverified.

`stale_after` is an ISO timestamp with an explicit timezone. Expiry makes a
Node behind even when it has a matching material version or verification.
Reads, no-op saves and lifecycle edits do not change its generation time.

## Record an output under its goal

Read the goal and create an output Node for the actual result:

```text
tent node link-output <goal-id> --resource <path-or-node-id> [--name <name>] [--by <actor>] --json
```

Relative file paths resolve from the Workspace root, so `out/page.html`
points to the workspace's `out` directory. `/` addresses resolve from `.tent`;
Node IDs and absolute URIs are also supported. Local files must exist and be
readable. The default Node name is the file name, numbered on collision;
`--name` overrides it. The saved address is relative to the new child.
The command returns the output Node ID; it does not edit the goal.
Cards referencing this goal derive progress from outputs added or confirmed
after their publication. Outputs need no Card source or additional parameter.
Describe independently useful results in that output Node. Existing outputs
can be moved under the appropriate goal. The nearest goal supplies the
implicit source and recorded goal version without extra frontmatter.

When the goal changes, review the affected output and confirm it, updating
its body if needed. Ordinary output edits retain the old goal basis.

`workspace drift` reports ahead and behind Nodes, including both findings when
they apply to one Node. The brief also lists recent session-written files not
recorded by any output Node. An independent output Node is already recorded
even when it has no goal ancestor. Stop can
suggest likely goals from this turn's observed files, but never creates or
confirms on your behalf. Save only actual confirmed intent and real results.
Session observations contain addresses and versions, not file or conversation
contents.

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
