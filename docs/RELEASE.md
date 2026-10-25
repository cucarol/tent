# Tent release notes

## Unreleased

- Interrupted saves recover as a complete old or new transaction on the next Tent open; `tent workspace repair` restores damaged Tent history while preserving other edits.

## 0.2.0

Tent can now join a project already under way. It drafts a module map from the code, asks at the end of each turn that changed mapped code whether a Node should change, and lets you lay related Nodes out together on the map to see how they relate. One build ships packages for both Codex and Claude Code.

### Joining an existing project

- `tent workspace scan` reports module-planning facts from the checkout: coverage, directory imports and cycles, generated directories, filename groups and guidance files. It writes nothing.
- `tent workspace scan --draft <file>` writes an editable module map in the `node write-many` format for an empty Tent. Each module is a goal that holds its directory or prefix as a `track: structure` source. Real directory layers become parent and child modules, and leaf modules aim at ten code files or fewer.
- `tent workspace check-modules` checks a module map against local imports and the latest 300 first-parent commits, and suggests one fix per issue.
- Imports are read from TypeScript, JavaScript, Python, Go, Rust, Java, C#, C, C++ and PHP. Each import is classed as `module-load`, `deferred`, `type-only` or `compile-time`; only load-time imports decide how modules are grouped.
- The tent-init Skill maps modules from these facts and records a rule only where a project file or test states it, as wide as that source.

### Materials

- A Node can track a directory, or a prefix such as `src/core/*`. Ignored files stay out.
- A module's `track: structure` source records which local dependencies its code has. `tent node check` lists the dependencies added or deleted since.
- Saving a goal or prompt whose local file Git does not track warns and suggests `output`, because Tent keeps no old bytes to compare.
- `tent workspace drift` shows each behind Node's materials with their recorded and current versions.
- Material paths resolve from the workspace root whatever the current directory.

### Ahead and behind

- An output records one moment. Changes to its materials or its goals no longer make it behind; only `stale_after` does. A full read lists what changed since in `changedSince`, and confirming the output clears it.
- A goal that covers a directory or prefix keeps its own basis. Confirming it clears ahead without an output; changing it makes it ahead again.
- `tent workspace brief` always lists every pending Card and returned result for the Role in scope. It no longer lists written files that no output records.

### Hooks

- Stop runs synchronously. When the turn wrote files that a module covers, it names those modules and asks whether one of them now says something wrong, or whether the turn produced a rule worth keeping. A turn that wrote nothing mapped gets no review.
- Edits made in a linked worktree count against the main checkout's modules, and Node edits there write to the main checkout's `.tent/`.
- SessionStart collects Node edits made with the Agent's own file tools and points to `tent workspace brief`.

### Cards

- A Card can name `returnTo`. The receiver ends it with `tent card return --result <text>`, and taking the returned Card collects the result. States are `pending`, `consumed`, `returned` and `closed`.
- `tent card watch` also wakes when a Card addressed back to the Role is returned.
- Each Role has an ordered queue of pending Cards. `tent card move` reorders a Card or sends it to another Role. A public area holds untargeted Cards; `tent card watch --include-open` shows them.
- Card progress (`has-output`, `needs-review`, `received-no-output`) is removed. Cards show delivery state only; goals keep their own ahead findings.
- `tent role delete` removes a Role and refuses while Cards still wait on it.

### Web UI

- The map is one canvas. Cards you move keep their place, and the layout, regions and drawings are saved in `.tent/canvas.json`.
- Hold one card over another and let go to form a region. Inside a region the map draws only relations Tent records: parent and child, citations, shared materials, code imports and results returned through Cards.
- A region reacts to the pairs of cards in it: Verify, Constrain, Contrast, Overlap, Co-govern, Sequence and Loop. Each reaction states facts; judging them is left to an Agent.
- A region can look one layer out and bring in the cards linked to it.
- Roles sit in the top bar as a stack that opens into a list. Drop cards or a region on a Role to start a Card for it, and drag waiting Cards to set the order it takes them in. Roles can be deleted from the page.
- The pen draws shapes, lines, freehand strokes and text, with undo and redo.
- The map exports as a PNG picture.
- A Node page shows the tests that import its code and the Nodes most often changed in the same commits.
- A file Node shows its file type, and a card can preview its file beneath it.

### Plugin

- One build produces Codex and Claude Code packages from the same CLI, Skills and specification.
- Agents read and edit Node Markdown with their own file tools. Tent records the edits at the next Tent command.
- The CLI shows times in the local time zone.

### Speed

- Reads reuse cached file observations that are checked against file state, and each command reads the workspace once.
- The map's first screen loads the graph and fetches details when opened.
- Stop finds covering modules from a persistent index that it updates only for changed files.
- `tent workspace brief` and the map skip Cards that are done, so finished Cards no longer slow them down.
- On a 2,000-Node workspace, a warm `tent workspace brief` is about six times faster than in 0.1.2, and the map's first screen about seven times faster.

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
