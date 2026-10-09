# Tent release notes

## 0.1.2

Tent is a project's context graph. This release makes it show what is ahead, goals nothing implements yet, and what is behind, facts whose material changed.

### Node types and tags

- A Node's `type` is exactly `goal`, `prompt` or `output`. Form and topic belong in `tags`. Any other type value, including the former `goal|prompt|output-<label>` form, makes the document an invalid Node.
- Tent suggests ten tag presets, such as `decision` and `evidence`. `tent node tags` lists the tags in use with their counts.
- `tent node type` and `tent node tags set|add|remove` change a Node's type and tags under an ETag.
- `tent node list --type <type> --tag <tag>` selects matching Nodes from a whole subtree.

### Ahead and behind

- Saving a Node records the versions of its `resource` and `sources` in `.tent/.git`. The Markdown carries no hash fields.
- `tent node check`, `tent workspace drift` and `tent workspace brief` report two findings. Ahead: a goal has no undeprecated output under it, or changed since its outputs were reviewed. A Node whose material changed, or whose `stale_after` time has passed, is behind.
- Behind propagates down the goal chain. Changing a goal's body or material makes every output under it behind, including through nested goals. Confirming the goal does not confirm its outputs.
- Every current output under a goal counts as implementing it, whatever its tags.
- `tent node confirm` records a review and refreshes the Node's versions. `tent node write --confirm` saves and confirms together. Rewriting an output's whole body also refreshes its dependencies.
- A Markdown material can track one section, as in `docs/design.md#State`.
- A tracked file missing from the workspace checkout is read from another checkout of the same repository, unless the main checkout also lacks it and its history deleted that path.
- `tent workspace brief` fits in 4 KiB. It also lists Card inputs and recently written files that no output records.

### Writing Nodes

- `tent node append` adds text without a prior read or ETag.
- `tent node get-section` and `tent node write-section` replace one Markdown section; edits to other sections do not conflict.
- Writes record OKF `generated` and confirmations record `verified`, each with an actor. `--by` names the actor.
- File paths in `--resource`, `--sources-json`, `tent card create --source` and `tent node link-output --resource` resolve from the workspace root.
- Node names follow Windows file-name rules on every platform.
- `tent node get` adds a bounded `context` of related Nodes and Cards.
- `tent workspace check` also reports missing Markdown sections and Node files that disagree with Tent Git.
- CLI writes wait briefly for a busy lock instead of failing at once.

### Cards

- Card progress comes from outputs whose `sources` name the Card; `tent node link-output --card <id>` records that link.
- A pending Card shows `pending`. A received Card shows `has-output` when every remaining goal has a current responding output. Otherwise it shows `needs-review` if an unfinished goal has a responding output awaiting review, such as a behind one, and `received-no-output` if not. A Card without goal sources, or whose goals are all deprecated, has no progress.
- `tent card deprecate` cancels a Card and keeps its input and reception. The interrupted state, `interrupt` and `continue` are removed.
- `tent card watch --role <role-id>` waits for pending Cards addressed to that Role.
- `tent card show` and `tent card take` list each source with its name, id and pinned version.
- When a source Node of a received Card changes, the brief asks the receiver to reread it.

### Web UI

- The page opens on Now: Role work from Card progress, outputs since your last visit, and current ahead and behind findings.
- The map marks ahead and behind Nodes and Cards awaiting review. Nodes can be confirmed from the page.
- Unsent Card drafts stay in the browser until you send them.
- The built-in Excalidraw annotations are removed. Save a sketch with Excalidraw as a workspace file and reference it from a Node.

### Skills and Hooks

- The four Skills are short checklists: when to act, which command to run and which field to read. All Agent-facing text stays under 12 KB.
- SessionStart states the workspace, the CLI, the build identity and a `tent workspace brief` hint.
- Stop states at most three findings: written files that no output records, changed materials that make a Node behind, and possible new decisions.

### Development

- The OKF specification is pinned in `docs/upstream/`. `npm run okf:upstream` reports upstream drift.
